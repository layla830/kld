#!/usr/bin/env python3
from __future__ import annotations

import unittest

from recall_decision import decide_recall


class RecallRoutingRegressionTest(unittest.TestCase):
    def assert_route(self, prompt: str, *, local: bool, remote: bool) -> None:
        decision = decide_recall(prompt)
        self.assertTrue(decision.should_recall, decision)
        self.assertEqual(local, decision.use_local, decision)
        self.assertEqual(remote, decision.use_remote, decision)

    def test_historical_date_uses_curated_timeline(self) -> None:
        self.assert_route("6月10日我们发生了什么", local=False, remote=True)

    def test_response_posture_question_uses_worker(self) -> None:
        self.assert_route("我哭的时候你应该怎么做", local=False, remote=True)

    def test_preference_question_uses_worker(self) -> None:
        self.assert_route("我不喜欢你用什么说话方式", local=False, remote=True)

    def test_relationship_history_uses_worker(self) -> None:
        self.assert_route("那次我们为什么吵架", local=False, remote=True)

    def test_status_question_uses_worker(self) -> None:
        self.assert_route("复婚是谁来提", local=False, remote=True)

    def test_recent_context_uses_vps(self) -> None:
        self.assert_route("刚才聊到哪了", local=True, remote=False)

    def test_explicit_raw_evidence_uses_vps(self) -> None:
        self.assert_route("把6月10日我当时的原话找出来", local=True, remote=False)

    def test_current_emotion_does_not_force_recall(self) -> None:
        decision = decide_recall("我现在好难过")
        self.assertFalse(decision.should_recall, decision)

    def test_trivial_message_does_not_recall(self) -> None:
        decision = decide_recall("好")
        self.assertFalse(decision.should_recall, decision)


if __name__ == "__main__":
    unittest.main(verbosity=2)
