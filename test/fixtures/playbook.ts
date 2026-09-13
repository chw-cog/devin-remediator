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
