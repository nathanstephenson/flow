import { startTestIssuer } from "../test/fixtures/oidc-issuer.ts";

const publicAppUrl = process.argv[2] ?? "http://127.0.0.1:5173";
const issuer = await startTestIssuer();

console.log("Local OIDC test issuer is running. It auto-admits the fixed subject ‘trusted-person’.\n");
console.log(`export FLOW_OIDC_ISSUER=${issuer.issuer}`);
console.log(`export FLOW_OIDC_CLIENT_ID=${issuer.clientId}`);
console.log(`export FLOW_OIDC_CLIENT_SECRET=${issuer.clientSecret}`);
console.log(`export FLOW_OIDC_PUBLIC_APP_URL=${publicAppUrl}`);
console.log(`\nRedirect URI:     ${publicAppUrl}/oauth/callback`);
console.log(`Back-channel URI: ${publicAppUrl}/oauth/backchannel`);
console.log("\nFor localhost development only. Press Ctrl-C to stop.");

const stop = async (): Promise<void> => {
  await issuer.close();
  process.exit(0);
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
await new Promise<void>(() => undefined);
