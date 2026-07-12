#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path
import unittest

from recall_decision import decide_recall


FIXTURES = json.loads(
    (Path(__file__).resolve().parents[2] / "fixtures" / "recall-ownership.json").read_text(encoding="utf-8")
)


class RecallRoutingRegressionTest(unittest.TestCase):
    def assert_route(self, prompt: str, *, local: bool, remote: bool) -> None:
        decision = decide_recall(prompt)
        self.assertTrue(decision.should_recall, decision)
        self.assertEqual(local, decision.use_local, decision)
        self.assertEqual(remote, decision.use_remote, decision)

    def test_shared_ownership_contract(self) -> None:
        for fixture in FIXTURES:
            with self.subTest(fixture=fixture["name"]):
                decision = decide_recall(fixture["prompt"])
                owner = fixture["expected_owner"]
                self.assertEqual(owner != "none", decision.should_recall, decision)
                self.assertEqual(owner == "local", decision.use_local, decision)
                self.assertEqual(owner == "worker", decision.use_remote, decision)


if __name__ == "__main__":
    unittest.main(verbosity=2)
