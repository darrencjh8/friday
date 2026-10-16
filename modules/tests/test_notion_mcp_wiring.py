from pathlib import Path
import unittest

import yaml


ROOT = Path(__file__).parents[2]
WORKFLOW = ROOT / ".github/workflows/deploy.yml"
HERMES_CONFIG = ROOT / "modules/hermes/config.yaml"
HERMES_DOCKERFILE = ROOT / "modules/hermes/Dockerfile"

MCP_PACKAGE = "@notionhq/notion-mcp-server@2.5.2"
READ_TOOLS = {
    "API-get-self",
    "API-post-search",
    "API-query-data-source",
    "API-retrieve-a-data-source",
    "API-retrieve-a-database",
    "API-retrieve-a-page",
    "API-retrieve-a-page-property",
    "API-retrieve-page-markdown",
    "API-get-block-children",
    "API-list-data-source-templates",
}
WRITE_TOOLS = {
    "API-post-page",
    "API-patch-page",
    "API-update-page-markdown",
    "API-create-a-comment",
}
# Destructive or schema-level operations this change deliberately does not expose
# as their own tool. Archiving stays reachable through the gated API-patch-page.
WITHHELD_TOOLS = {
    "API-delete-a-block",
    "API-update-a-block",
    "API-patch-block-children",
    "API-create-a-data-source",
    "API-update-a-data-source",
    "API-move-page",
}


class NotionMcpWiringTests(unittest.TestCase):
    def test_workflow_uses_the_existing_notion_api_token_secret(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")

        self.assertIn("NOTION_API_KEY: ${{ secrets.NOTION_API_TOKEN }}", workflow)
        # The darren-prod environment scope holds NOTION_API_TOKEN; a reference to
        # a differently named secret interpolates to an empty string and fails
        # silently, because deploy.sh validates this variable as optional.
        self.assertNotIn("secrets.NOTION_API_KEY", workflow)

    def test_workflow_installs_the_pinned_mcp_server_into_the_volume(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")

        # Installed into the persisted volume, like gh and ntn, so an image
        # rebuild or a container recreate reuses it instead of reinstalling.
        self.assertIn(
            "npm install --global --prefix /opt/data/.local " + MCP_PACKAGE,
            workflow,
        )
        self.assertIn(
            "npm ls --global --prefix /opt/data/.local --depth=0 "
            "@notionhq/notion-mcp-server",
            workflow,
        )
        # The version match is anchored: the pin is a prefix of a longer version,
        # so an unanchored match would accept 2.5.20 and skip the reinstall.
        self.assertIn(
            r"grep -qE '@notionhq/notion-mcp-server@2\.5\.2([[:space:]]|$)'",
            workflow,
        )
        # The step's closing verification exercises the tool.
        self.assertIn(
            "gh --version && ntn --version && command -v notion-mcp-server",
            workflow,
        )
        # CLI tools live in the volume, never in an image layer.
        dockerfile = HERMES_DOCKERFILE.read_text(encoding="utf-8")
        self.assertNotIn("npm install --global", dockerfile)

    def test_tooling_step_still_installs_when_the_deploy_failed(self):
        workflow = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
        steps = workflow["jobs"]["deploy"]["steps"]
        step = next(
            s for s in steps if s.get("name") == "Ensure Hermes container tooling"
        )

        # Deploy services runs first and exits non-zero when a service is
        # unhealthy. A `success() &&` guard would then skip this step forever, so
        # the pinned server would never reach the volume and every retry would
        # fail identically. `always() &&` keeps the install reachable from the
        # red state, so the next deploy converges.
        condition = " ".join(str(step["if"]).split())
        self.assertTrue(condition.startswith("always() &&"), condition)

    def test_config_registers_read_and_gated_write_servers(self):
        config = yaml.safe_load(HERMES_CONFIG.read_text(encoding="utf-8"))
        servers = config["mcp_servers"]

        read = servers["notion"]
        write = servers["notion-write"]

        for server in (read, write):
            self.assertEqual(server["command"], "notion-mcp-server")
            self.assertEqual(server["env"], {"NOTION_TOKEN": "${NOTION_API_KEY}"})
            self.assertFalse(server["tools"]["resources"])
            self.assertFalse(server["tools"]["prompts"])

        # Reads run without an approval prompt, so every read tool is here and no
        # write tool is.
        self.assertEqual(set(read["tools"]["include"]), READ_TOOLS)

        # Writes are gated: `trust: untrusted` sends every tool without a
        # readOnlyHint through the approval surface. Search and query are POSTs,
        # which is why they live in the ungated entry instead.
        self.assertEqual(write.get("trust"), "untrusted")
        self.assertEqual(set(write["tools"]["include"]), WRITE_TOOLS)

        exposed = set(read["tools"]["include"]) | set(write["tools"]["include"])
        self.assertEqual(exposed & WITHHELD_TOOLS, set())
        self.assertEqual(READ_TOOLS & WRITE_TOOLS, set())


if __name__ == "__main__":
    unittest.main()
