import { z } from 'zod'

export const querySchema = z
  .object({
    auth_key: z.string(),
    auth_timestamp: z.string(),
    auth_version: z.string(),
    auth_signature: z.string(),
    body_md5: z.string().optional(),
  })
  .catchall(z.string())

export const eventSchema = z
  .object({
    name: z.string().nonempty(),
    channels: z.array(z.string()).nonempty().optional(),
    channel: z.string().nonempty().optional(),
    data: z.string(),
    socket_id: z.string().optional(),
    info: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.channels && !data.channel) {
      ctx.addIssue({
        code: 'custom',
        message: 'Either channels or channel is required',
        path: ['channels'],
      })
    }
  })

export type Event = z.infer<typeof eventSchema>

export const batchEventSchema = z.object({
  batch: z
    .array(
      z.object({
        name: z.string().nonempty(),
        channel: z.string().nonempty(),
        data: z.string(),
        socket_id: z.string().optional(),
        info: z.string().optional(),
      }),
    )
    .nonempty()
    .max(10),
})

export type BatchEvent = z.infer<typeof batchEventSchema>
