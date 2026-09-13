import app from "./app.ts";

if (import.meta.main) {
  Deno.serve({ port: 8000 }, app.fetch);
}
