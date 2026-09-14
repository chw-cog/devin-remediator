import type { DevinPlaybook } from "../../src/devin.ts";

export const playbook: DevinPlaybook = {
  playbook_id: "playbook-test",
  title: "Existing issue playbook",
  body: "Existing instructions, left unchanged",
  macro: "!fix-superset-issue",
  created_by: "service-test",
  updated_by: "service-test",
  created_at: 1700000000,
  updated_at: 1700000000,
  access_type: "org",
  org_id: "org-test",
};

export const withPlaybookStartup =
  (fetch: typeof globalThis.fetch): typeof globalThis.fetch =>
  async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === "https://api.devin.ai") {
      if (
        request.method === "GET" &&
        url.pathname === "/v3/organizations/org-test/playbooks"
      ) {
        return Response.json({ items: [playbook], has_next_page: false });
      }
      if (
        request.method === "PUT" &&
        url.pathname === "/v3/organizations/org-test/playbooks/playbook-test"
      ) {
        return Response.json({ ...playbook, ...await request.json() });
      }
    }
    return fetch(input, init);
  };
