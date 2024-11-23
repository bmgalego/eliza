import { GoalStatus } from "@ai16z/eliza";
import { Account, IDatabaseAdapter, UUID } from "@ai16z/eliza";
import { initTRPC } from "@trpc/server";
import { z } from "zod";

// Initialize tRPC
const t = initTRPC.context<{ db: IDatabaseAdapter }>().create();
const router = t.router;
const procedure = t.procedure;

const UUIDSchema = z
    .string()
    .uuid()
    .transform((s) => s as UUID);

const AccountSchema = z.object({
    id: UUIDSchema,
    name: z.string(),
    username: z.string(),
    details: z.record(z.any()).optional(),
    email: z.string().email().optional(),
    avatarUrl: z.string().url().optional(),
});

const MemorySchema = z.object({
    id: UUIDSchema.optional(),
    userId: UUIDSchema,
    agentId: UUIDSchema,
    createdAt: z.number().optional(),
    content: z.object({
        text: z.string(),
        action: z.string().optional(),
        source: z.string().optional(),
        url: z.string().optional(),
        inReplyTo: UUIDSchema.optional(),
        attachments: z.array(z.any()).optional(),
    }),
    embedding: z.array(z.number()).optional(),
    roomId: UUIDSchema,
    unique: z.boolean().optional(),
});

const GoalSchema = z.object({
    id: UUIDSchema.optional(),
    roomId: UUIDSchema,
    userId: UUIDSchema,
    name: z.string(),
    status: z.nativeEnum(GoalStatus),
    objectives: z.array(
        z.object({
            id: z.string().optional(),
            description: z.string(),
            completed: z.boolean(),
        })
    ),
});

const RelationshipSchema = z.object({
    id: UUIDSchema,
    userA: UUIDSchema,
    userB: UUIDSchema,
    userId: UUIDSchema,
    roomId: UUIDSchema,
    status: z.string(),
    createdAt: z.string().optional(),
});

const RoomSchema = z.object({
    id: UUIDSchema,
    participants: z.array(
        z.object({
            id: UUIDSchema,
            account: AccountSchema,
        })
    ),
});

export type AppRouter = typeof appRouter;

// Full Router
export const appRouter = router({
    getAccountById: procedure
        .input(z.object({ userId: UUIDSchema }))
        .query(({ input, ctx }) => ctx.db.getAccountById(input.userId)),

    createAccount: procedure
        .input(AccountSchema)
        .mutation(({ input, ctx }) => ctx.db.createAccount(input)),

    getMemories: procedure
        .input(
            z.object({
                agentId: UUIDSchema,
                roomId: UUIDSchema,
                count: z.number().optional(),
                unique: z.boolean().optional(),
                tableName: z.string(),
                start: z.number().optional(),
                end: z.number().optional(),
            })
        )
        .query(({ input, ctx }) => ctx.db.getMemories(input)),

    createMemory: procedure
        .input(
            z.object({
                memory: MemorySchema,
                tableName: z.string(),
                unique: z.boolean().optional(),
            })
        )
        .mutation(({ input, ctx }) =>
            ctx.db.createMemory(input.memory, input.tableName, input.unique)
        ),

    removeMemory: procedure
        .input(
            z.object({
                memoryId: UUIDSchema,
                tableName: z.string(),
            })
        )
        .mutation(({ input, ctx }) =>
            ctx.db.removeMemory(input.memoryId, input.tableName)
        ),

    getRoom: procedure
        .input(z.object({ roomId: UUIDSchema }))
        .query(({ input, ctx }) => ctx.db.getRoom(input.roomId)),

    createRoom: procedure
        .input(z.object({ roomId: UUIDSchema.optional() }))
        .mutation(({ input, ctx }) => ctx.db.createRoom(input.roomId)),

    removeRoom: procedure
        .input(z.object({ roomId: UUIDSchema }))
        .mutation(({ input, ctx }) => ctx.db.removeRoom(input.roomId)),

    getGoals: procedure
        .input(
            z.object({
                agentId: UUIDSchema,
                roomId: UUIDSchema,
                userId: UUIDSchema.optional(),
                onlyInProgress: z.boolean().optional(),
                count: z.number().optional(),
            })
        )
        .query(({ input, ctx }) => ctx.db.getGoals(input)),

    createGoal: procedure
        .input(GoalSchema)
        .mutation(({ input, ctx }) => ctx.db.createGoal(input)),

    updateGoalStatus: procedure
        .input(
            z.object({
                goalId: UUIDSchema,
                status: z.nativeEnum(GoalStatus),
            })
        )
        .mutation(({ input, ctx }) => ctx.db.updateGoalStatus(input)),

    removeGoal: procedure
        .input(z.object({ goalId: UUIDSchema }))
        .mutation(({ input, ctx }) => ctx.db.removeGoal(input.goalId)),

    getRelationships: procedure
        .input(z.object({ userId: UUIDSchema }))
        .query(({ input, ctx }) => ctx.db.getRelationships(input)),

    createRelationship: procedure
        .input(z.object({ userA: UUIDSchema, userB: UUIDSchema }))
        .mutation(({ input, ctx }) => ctx.db.createRelationship(input)),

    addParticipant: procedure
        .input(
            z.object({
                userId: UUIDSchema,
                roomId: UUIDSchema,
            })
        )
        .mutation(({ input, ctx }) =>
            ctx.db.addParticipant(input.userId, input.roomId)
        ),

    removeParticipant: procedure
        .input(
            z.object({
                userId: UUIDSchema,
                roomId: UUIDSchema,
            })
        )
        .mutation(({ input, ctx }) =>
            ctx.db.removeParticipant(input.userId, input.roomId)
        ),

    getParticipantsForRoom: procedure
        .input(z.object({ roomId: UUIDSchema }))
        .query(({ input, ctx }) => ctx.db.getParticipantsForRoom(input.roomId)),
});
