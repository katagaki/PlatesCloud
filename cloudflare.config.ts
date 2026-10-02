import { bindings, defineConfig, exports } from "cf/config";

// The config runs in Node, but tsconfig only loads Workers types.
declare const process: { env: Record<string, string | undefined> };

const text = (name: string) => bindings.text(process.env[name] ?? "");

export default defineConfig((ctx) => {
	const name = ctx.mode === "staging" ? "plates-cloud-beta" : "plates-cloud";
	return {
		worker: {
			name,
			compatibilityDate: "2026-08-22",
			entrypoint: "src/index.ts",
			observability: {
				enabled: true,
			},
			exports: {
				Device: exports.durableObject({ storage: "sqlite" }),
			},
			env: {
				APPLE_TEAM_ID: text("APPLE_TEAM_ID"),
				APP_BUNDLE_ID: text("APP_BUNDLE_ID"),
				APP_ATTEST_ENVIRONMENT: text("APP_ATTEST_ENVIRONMENT"),
				WRITE_DAILY_LIMIT: text("WRITE_DAILY_LIMIT"),
				IDEATE_DAILY_LIMIT: text("IDEATE_DAILY_LIMIT"),
				DECIDE_DAILY_LIMIT: text("DECIDE_DAILY_LIMIT"),
				TOPPINGS_DAILY_LIMIT: text("TOPPINGS_DAILY_LIMIT"),
				DEVICE: bindings.durableObject({
					worker: name,
					exportName: "Device",
				}),
				AI: bindings.ai({}),
			},
		},
	};
});
