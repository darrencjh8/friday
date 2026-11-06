from pathlib import Path
import unittest

import yaml


ROOT = Path(__file__).parents[2]
WORKFLOW = ROOT / ".github/workflows/deploy.yml"
HERMES_CONFIG = ROOT / "modules/hermes/config.yaml"

READ_TOOLS = {
    "notion-fetch",
    "notion-get-comments",
    "notion-get-self",
    "notion-get-tool-access",
    "notion-query-data-sources",
    "notion-search",
}
WRITE_TOOLS = {
    "notion-create-comment",
    "notion-create-pages",
    "notion-get-async-task",
    "notion-update-page",
}
# Writes run without an approval prompt, so anything that deletes, moves or
# reshapes workspace content stays off the allowlist.
WITHHELD_TOOLS = {
    "notion-delete-comment",
    "notion-delete-databases",
    "notion-delete-pages",
    "notion-move-pages",
    "notion-spawn-session",
    "notion-update-data-source",
}


class NotionMcpWiringTests(unittest.TestCase):
    def test_workflow_uses_the_existing_notion_api_token_secret(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")

        # The cron scripts and the notion skill still call the REST API with the
        # integration token; only the MCP surface moved to OAuth.
        self.assertIn("NOTION_API_KEY: ${{ secrets.NOTION_API_TOKEN }}", workflow)
        # The darren-prod environment scope holds NOTION_API_TOKEN; a reference to
        # a differently named secret interpolates to an empty string and fails
        # silently, because deploy.sh validates this variable as optional.
        self.assertNotIn("secrets.NOTION_API_KEY", workflow)

    def test_workflow_no_longer_installs_the_self_hosted_server(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")

        self.assertNotIn("notion-mcp-server", workflow)
        self.assertIn("gh --version && ntn --version", workflow)

    def test_tooling_step_still_installs_when_the_deploy_failed(self):
        workflow = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
        steps = workflow["jobs"]["deploy"]["steps"]
        step = next(
            s for s in steps if s.get("name") == "Ensure Hermes container tooling"
        )

        # Deploy services runs first and exits non-zero when a service is
        # unhealthy. A `success() &&` guard would then skip this step forever, so
        # the tools would never reach the volume and every retry would fail
        # identically. `always() &&` keeps the install reachable from the red
        # state, so the next deploy converges.
        condition = " ".join(str(step["if"]).split())
        self.assertTrue(condition.startswith("always() &&"), condition)

    def test_config_registers_the_hosted_server_over_oauth(self):
        config = yaml.safe_load(HERMES_CONFIG.read_text(encoding="utf-8"))
        servers = config["mcp_servers"]
        server = servers["notion"]

        self.assertEqual(server["url"], "https://mcp.notion.com/mcp")
        self.assertEqual(server["auth"], "oauth")
        # A static token here would bypass the OAuth login and land in the seed.
        self.assertNotIn("headers", server)
        self.assertNotIn("command", server)
        self.assertNotIn("env", server)
        self.assertFalse(server["tools"]["resources"])
        self.assertFalse(server["tools"]["prompts"])

        # The seed lets the baked mcp_servers win, so dropping the entry here also
        # removes it from the live config.
        self.assertNotIn("notion-write", servers)

    def test_writes_are_unprompted_and_the_allowlist_is_exact(self):
        config = yaml.safe_load(HERMES_CONFIG.read_text(encoding="utf-8"))
        server = config["mcp_servers"]["notion"]

        self.assertNotIn("trust", server)
        exposed = set(server["tools"]["include"])
        self.assertEqual(exposed, READ_TOOLS | WRITE_TOOLS)
        self.assertEqual(exposed & WITHHELD_TOOLS, set())


if __name__ == "__main__":
    unittest.main()
