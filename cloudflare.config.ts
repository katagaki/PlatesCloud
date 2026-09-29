import { bindings, defineConfig, exports } from "cf/config";

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
				APPLE_TEAM_ID: bindings.text(""),
				APP_BUNDLE_ID: bindings.text(""),
				APP_ATTEST_ENVIRONMENT: bindings.text(""),
				WRITE_DAILY_LIMIT: bindings.text(""),
				DECIDE_DAILY_LIMIT: bindings.text(""),
				DEVICE: bindings.durableObject({
					worker: name,
					exportName: "Device",
				}),
				AI: bindings.ai({}),
			},
		},
	};
});
