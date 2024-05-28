import { getKindeServerSession } from "@kinde-oss/kinde-auth-nextjs/server";
import { TRPCError } from "@trpc/server";
import { UTApi } from "uploadthing/server";
import * as z from "zod";

import { INFINITE_QUERY_LIMIT } from "@/config/infinite-query";
import { PLANS } from "@/config/stripe";
import { db } from "@/db";
import { getUserSubscriptionPlan, stripe } from "@/lib/stripe";
import { absoluteUrl } from "@/lib/utils";

import { privateProcedure, procedure, router } from "./trpc";

export const appRouter = router({
  authCallback: procedure.query(async () => {
    const { getUser } = getKindeServerSession();
    const user = await getUser();

    if (!user || !user.id || !user.email)
      throw new TRPCError({ code: "UNAUTHORIZED" });

    // check if user is in the database
    const dbUser = await db.user.findUnique({
      where: {
        id: user.id,
      },
    });

    if (!dbUser) {
      // create user in db
      await db.user.create({
        data: {
          id: user.id,
          email: user.email,
        },
      });
    }

    return {
      success: true,
    };
  }),
  getUserFiles: privateProcedure.query(async ({ ctx }) => {
    const { userId } = ctx;

    return await db.file.findMany({
      where: {
        userId,
      },
      include: {
        _count: {
          select: {
            messages: true,
          },
        },
      },
    });
  }),
  deleteFile: privateProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { userId } = ctx;

      const file = await db.file.findUnique({
        where: {
          id: input.id,
          userId,
        },
      });

      if (!file) throw new TRPCError({ code: "NOT_FOUND" });

      // delete file from db
      await db.file.delete({
        where: {
          id: input.id,
          userId,
        },
      });

      // delete file from uploadthing
      const utapi = new UTApi();
      await utapi.deleteFiles(file.key);

      return file;
    }),
  getFile: privateProcedure
    .input(z.object({ key: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { userId } = ctx;

      const file = await db.file.findUnique({
        where: {
          key: input.key,
          userId,
        },
      });

      if (!file) throw new TRPCError({ code: "NOT_FOUND" });

      return file;
    }),
  getFileUploadStatus: privateProcedure
    .input(z.object({ fileId: z.string() }))
    .query(async ({ ctx, input }) => {
      const file = await db.file.findUnique({
        where: {
          id: input.fileId,
          userId: ctx.userId,
        },
      });

      if (!file) return { status: "PENDING" as const };

      return {
        status: file.uploadStatus,
      };
    }),
  getFileMessages: privateProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).nullish(),
        cursor: z.string().nullish(),
        fileId: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { userId } = ctx;
      const { fileId, cursor } = input;
      const limit = input.limit ?? INFINITE_QUERY_LIMIT;

      const file = await db.file.findUnique({
        where: {
          id: fileId,
          userId,
        },
      });

      if (!file) throw new TRPCError({ code: "NOT_FOUND" });

      const messages = await db.message.findMany({
        take: limit + 1,
        where: {
          fileId,
          userId,
        },
        orderBy: {
          createdAt: "desc",
        },
        cursor: cursor ? { id: cursor } : undefined,
        select: {
          id: true,
          isUserMessage: true,
          createdAt: true,
          text: true,
        },
      });

      let nextCursor: typeof cursor | undefined = undefined;

      if (messages.length > limit) {
        const nextItem = messages.pop();

        nextCursor = nextItem?.id;
      }

      return {
        messages,
        nextCursor,
      };
    }),
    createStripeSession: privateProcedure.mutation(async ({ ctx }) => {
      const { userId } = ctx;
      const billingUrl = absoluteUrl("/dashboard/billing");
    
      if (!userId) {
        console.error("Unauthorized access: missing userId");
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }
    
      let dbUser;
      try {
        dbUser = await db.user.findUnique({
          where: { id: userId },
        });
      } catch (error) {
        console.error("Error finding user in database:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Error finding user in database" });
      }
    
      if (!dbUser) {
        console.error("Unauthorized access: user not found");
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }
    
      let subscriptionPlan;
      try {
        subscriptionPlan = await getUserSubscriptionPlan();
      } catch (error) {
        console.error("Error fetching user subscription plan:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Error fetching user subscription plan" });
      }
    
      try {
        if (subscriptionPlan.isSubscribed && dbUser.stripeCustomerId) {
          const stripeSession = await stripe.billingPortal.sessions.create({
            customer: dbUser.stripeCustomerId,
            return_url: billingUrl,
          });
          return { url: stripeSession.url };
        }
    
        const stripeSession = await stripe.checkout.sessions.create({
          success_url: billingUrl,
          cancel_url: billingUrl,
          payment_method_types: ["card"],
          mode: "subscription",
          customer_email: dbUser.email,
          billing_address_collection: "required",
          line_items: [
            {
              price: PLANS.find((plan) => plan.name === "Pro")?.price.priceIds.test,
              quantity: 1,
            },
          ],
          metadata: { userId },
        });
    
        return { url: stripeSession.url };
      } catch (error) {
        console.error("Error creating Stripe session:", error);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to create Stripe session" });
      }
    }),
    
});

export type AppRouter = typeof appRouter;