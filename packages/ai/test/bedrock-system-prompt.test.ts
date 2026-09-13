import { describe, expect, test } from "bun:test";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import type { Context, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

interface Payload {
	system?: Array<{ text: string } | { cachePoint: unknown }>;
	messages?: Array<{ role: string; content: Array<Record<string, unknown>> }>;
}

function model(overrides: Partial<ModelSpec<"bedrock-converse-stream">> = {}): Model<"bedrock-converse-stream"> {
	return buildModel({
		id: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
		name: "haiku",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: false,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		...overrides,
	} as ModelSpec<"bedrock-converse-stream">);
}

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

async function captureRequestPayload(
	bedrockModel: Model<"bedrock-converse-stream">,
	context: Context,
	cacheRetention?: "none" | "short" | "long",
): Promise<Payload> {
	const { promise, resolve } = Promise.withResolvers<Payload | undefined>();
	const stream = streamBedrock(bedrockModel, context, {
		bearerToken: "test-token",
		signal: abortedSignal(),
		cacheRetention,
		onPayload: payload => {
			resolve(payload as Payload);
		},
	});
	// Drain the stream so the request-building path (and thus onPayload) runs.
	void (async () => {
		try {
			for await (const _ of stream) {
				// ignore events; we only care about the captured payload
			}
		} finally {
			resolve(undefined);
		}
	})();
	const payload = await promise;
	if (!payload) throw new Error("payload was not captured");
	return payload;
}

// Capture the request payload the provider would send, without a network call:
// an already-aborted signal short-circuits after `onPayload` fires.
async function capturePayload(systemPrompt: Context["systemPrompt"]): Promise<Payload> {
	return captureRequestPayload(model(), {
		systemPrompt,
		messages: [{ role: "user", content: "hi", timestamp: 0 }],
	});
}

function textBlocks(payload: Payload): string[] {
	return (payload.system ?? []).filter((block): block is { text: string } => "text" in block).map(block => block.text);
}

describe("Bedrock system prompt normalization", () => {
	// Regression for #7037: legacy pi extensions remapped onto the fork pass
	// Context.systemPrompt as a bare string, which crashed buildSystemPrompt's
	// unguarded `.map()`. It must normalize to a single-element system block.
	test("accepts a bare-string systemPrompt", async () => {
		const payload = await capturePayload("You are a test." as unknown as string[]);
		expect(textBlocks(payload)).toEqual(["You are a test."]);
	});

	test("string and single-element array produce identical system blocks", async () => {
		const fromString = await capturePayload("You are a test." as unknown as string[]);
		const fromArray = await capturePayload(["You are a test."]);
		expect(textBlocks(fromString)).toEqual(textBlocks(fromArray));
	});

	test("detects supported Claude families without enabling older Claude or Nova models", () => {
		for (const id of [
			"us.anthropic.claude-opus-4-8",
			"us.anthropic.claude-sonnet-5",
			"us.anthropic.claude-fable-5",
			"us.anthropic.claude-mythos-5",
		]) {
			expect(model({ id }).compat.supportsMidConversationSystem).toBe(true);
		}
		expect(model({ id: "us.anthropic.claude-sonnet-4-6" }).compat.supportsMidConversationSystem).toBe(false);
		expect(model({ id: "us.amazon.nova-pro-v1:0" }).compat.supportsMidConversationSystem).toBe(false);
	});

	test("emits eligible developer instructions as Bedrock system messages", async () => {
		const payload = await captureRequestPayload(model({ id: "us.anthropic.claude-opus-4-8" }), {
			messages: [
				{ role: "user", content: "Review this.", timestamp: 0 },
				{
					role: "developer",
					content: [{ type: "text", text: "Treat warnings as errors." }],
					attribution: "agent",
					timestamp: 1,
				},
			],
		});

		expect(payload.messages?.map(message => message.role)).toEqual(["user", "system"]);
		expect(payload.messages?.[1]?.content).toContainEqual({ text: "Treat warnings as errors." });
	});

	test("keeps unsupported, first-position, and image-bearing developer turns on user", async () => {
		const unsupported = await captureRequestPayload(model({ id: "us.anthropic.claude-sonnet-4-6" }), {
			messages: [
				{ role: "user", content: "Review this.", timestamp: 0 },
				{
					role: "developer",
					content: [{ type: "text", text: "Treat warnings as errors." }],
					attribution: "agent",
					timestamp: 1,
				},
			],
		});
		expect(unsupported.messages?.map(message => message.role)).toEqual(["user", "user"]);

		const supported = model({ id: "us.anthropic.claude-opus-4-8", input: ["text", "image"] });
		const guarded = await captureRequestPayload(supported, {
			messages: [
				{
					role: "developer",
					content: [{ type: "text", text: "Global rule." }],
					attribution: "agent",
					timestamp: 0,
				},
				{ role: "user", content: "Review this.", timestamp: 1 },
				{
					role: "developer",
					content: [{ type: "text", text: "Do not outrank the following image turn." }],
					attribution: "agent",
					timestamp: 2,
				},
				{
					role: "developer",
					content: [
						{ type: "text", text: "Match this reference." },
						{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
					],
					attribution: "agent",
					timestamp: 3,
				},
				{
					role: "developer",
					content: [{ type: "text", text: "This trailing instruction may be privileged." }],
					attribution: "agent",
					timestamp: 4,
				},
			],
		});
		expect(guarded.messages?.map(message => message.role)).toEqual(["user", "user", "user", "user", "system"]);
	});

	test("retains the final message cache point when promoting it to system", async () => {
		const payload = await captureRequestPayload(
			model({ id: "us.anthropic.claude-opus-4-8" }),
			{
				systemPrompt: ["Stable instructions."],
				messages: [
					{ role: "user", content: "Review this.", timestamp: 0 },
					{
						role: "developer",
						content: [{ type: "text", text: "Treat warnings as errors." }],
						attribution: "agent",
						timestamp: 1,
					},
				],
			},
			"long",
		);

		expect(payload.messages?.at(-1)).toEqual({
			role: "system",
			content: [{ text: "Treat warnings as errors." }, { cachePoint: { type: "default", ttl: "1h" } }],
		});
	});
});
