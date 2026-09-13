import app from "./app.ts";

if (import.meta.main) {
  const env = {
    DEVIN_API_KEY: Deno.env.get("DEVIN_API_KEY"),
    DEVIN_ORGANIZATION_ID: Deno.env.get("DEVIN_ORGANIZATION_ID"),
  };
  Deno.serve({ port: 8000 }, (request) => app.fetch(request, env));
}
