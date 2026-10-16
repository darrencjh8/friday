"""GitHub rejects a workflow whose mappings repeat a key; PyYAML silently keeps the last one."""
from pathlib import Path
import unittest

import yaml


WORKFLOWS = Path(__file__).parents[2] / ".github/workflows"


class _UniqueKeyLoader(yaml.SafeLoader):
    pass


def _construct_mapping(loader, node, deep=False):
    seen = set()
    for key_node, _ in node.value:
        key = loader.construct_object(key_node, deep=deep)
        folded = key.lower() if isinstance(key, str) else key
        if folded in seen:
            raise yaml.constructor.ConstructorError(
                None, None, f"duplicate key {key!r}", key_node.start_mark
            )
        seen.add(folded)
    return loader.construct_mapping(node, deep=deep)


_UniqueKeyLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _construct_mapping
)


class WorkflowDuplicateKeyTests(unittest.TestCase):
    def test_no_workflow_repeats_a_mapping_key(self):
        files = sorted(WORKFLOWS.glob("*.yml")) + sorted(WORKFLOWS.glob("*.yaml"))
        self.assertTrue(files)
        for path in files:
            with self.subTest(workflow=path.name):
                yaml.load(path.read_text(), Loader=_UniqueKeyLoader)


if __name__ == "__main__":
    unittest.main()
