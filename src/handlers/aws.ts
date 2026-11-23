/**
 * The AWS side of the handlers: sending pokes to SQS FIFO, and scheduling
 * wake-ups with EventBridge Scheduler (ADR-0027).
 */

import { createHash } from "node:crypto";
import {
	ConflictException,
	CreateScheduleCommand,
	type CreateScheduleCommandInput,
	type SchedulerClient,
	UpdateScheduleCommand,
} from "@aws-sdk/client-scheduler";
import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import {
	deduplicationId,
	messageGroupId,
	type Outbox,
	type QueueMessage,
	type Waker,
} from "./messages";

/** Scheduler's `at()` fires with about a minute's precision; sooner than this is "now". */
const MIN_SCHEDULE_SECONDS = 60;

export class SqsOutbox implements Outbox {
	constructor(
		private readonly sqs: SQSClient,
		private readonly queueUrl: string,
	) {}

	async send(m: QueueMessage): Promise<void> {
		await this.sqs.send(
			new SendMessageCommand({
				QueueUrl: this.queueUrl,
				MessageBody: JSON.stringify(m),
				MessageGroupId: messageGroupId(m),
				MessageDeduplicationId: deduplicationId(m),
			}),
		);
	}
}

/** `at(2026-01-02T03:04:05)`, in UTC. */
export function atExpression(epochSeconds: number): string {
	return `at(${new Date(epochSeconds * 1000).toISOString().slice(0, 19)})`;
}

/** Stable per queue, so a newer wake-up replaces the pending one instead of piling up. */
export function scheduleName(m: QueueMessage): string {
	return `mq-wake-${createHash("sha256").update(messageGroupId(m)).digest("hex").slice(0, 48)}`;
}

/**
 * SQS FIFO has no per-message delay, so a wake-up is a one-off EventBridge
 * Scheduler schedule that sends the poke to the queue and then deletes
 * itself. The queue has content-based deduplication on for these deliveries;
 * the message id (`wake:<epoch>`) keeps each wake-up distinct.
 */
export class SchedulerWaker implements Waker {
	constructor(
		private readonly scheduler: SchedulerClient,
		private readonly outbox: Outbox,
		private readonly opts: { queueArn: string; roleArn: string; group: string; now(): number },
	) {}

	async wakeAt(m: QueueMessage, at: number): Promise<void> {
		const now = this.opts.now();
		if (at - now <= 1) {
			// "Come straight back": no point scheduling what is due now.
			await this.outbox.send(m);
			return;
		}
		const input: CreateScheduleCommandInput = {
			Name: scheduleName(m),
			GroupName: this.opts.group,
			ScheduleExpression: atExpression(Math.max(at, now + MIN_SCHEDULE_SECONDS)),
			ScheduleExpressionTimezone: "UTC",
			FlexibleTimeWindow: { Mode: "OFF" },
			ActionAfterCompletion: "DELETE",
			Target: {
				Arn: this.opts.queueArn,
				RoleArn: this.opts.roleArn,
				Input: JSON.stringify(m),
				SqsParameters: { MessageGroupId: messageGroupId(m) },
			},
		};
		try {
			await this.scheduler.send(new CreateScheduleCommand(input));
		} catch (e) {
			if (!(e instanceof ConflictException)) throw e;
			// One already pending for this queue: the newest decision wins.
			await this.scheduler.send(new UpdateScheduleCommand(input));
		}
	}
}
