"""
index.py と validators.py の結線を検証するテスト（AWS 接続なし）

validators.py 単体の振る舞いは test_validators.py が網羅している。
ここで見るのは「ハンドラーが検証を通しているか」と、
「検証モジュールがデプロイ ZIP に含まれているか」の 2 点。

後者を入れてあるのは、同リポジトリで「共通モジュールを結線したが
archive_file に追加し忘れ、Lambda が ImportError で落ちる」欠陥を
実際に出しているため。テストは同ディレクトリを sys.path に載せて動くので
カバレッジでは気づけない。パッケージング定義そのものを固定する。
"""

import ast
import json
import os
import re
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

os.environ.setdefault("AWS_REGION", "ap-northeast-1")
os.environ.setdefault(
    "SNS_TOPIC_ARN", "arn:aws:sns:ap-northeast-1:123456789012:test-alert"
)
sys.path.insert(0, os.path.dirname(__file__))

from index import DEFAULT_METRICS_NAMESPACE, lambda_handler  # noqa: E402
from logger import create_logger  # noqa: E402
from metrics import create_metrics  # noqa: E402

_HANDLER_DIR = Path(__file__).resolve().parent
_SECURITY_TF = _HANDLER_DIR.parents[1] / "terraform" / "security.tf"


# ── ヘルパー ─────────────────────────────────────────────────


def _make_event(**detail_overrides) -> dict:
    """検証を通る正常イベント。detail を上書きして壊したケースを作る。"""
    detail = {
        "id": "finding-001",
        "severity": 8.5,
        "type": "UnauthorizedAccess:EC2/SSHBruteForce",
        "title": "SSH ブルートフォース攻撃を検知",
        "description": "EC2 インスタンスへの総当たり攻撃を検出しました",
        "region": "ap-northeast-1",
        "accountId": "123456789012",
    }
    for key, value in detail_overrides.items():
        if value is None:
            detail.pop(key, None)
        else:
            detail[key] = value
    return {"source": "aws.guardduty", "detail": detail}


class _Collected:
    """ログ行と EMF 行を集めて、注入用の logger / metrics を返す。"""

    def __init__(self, namespace: str = DEFAULT_METRICS_NAMESPACE) -> None:
        self.logs: list[dict] = []
        self.emf: list[dict] = []
        self.logger = create_logger(
            level="debug",
            sink=lambda line, level: self.logs.append(json.loads(line)),
        )
        self.metrics = create_metrics(
            namespace,
            sink=lambda line: self.emf.append(json.loads(line)),
            Handler="guardduty-notifier",
        )

    def find_log(self, message: str) -> dict | None:
        for entry in self.logs:
            if entry.get("message") == message:
                return entry
        return None

    @property
    def document(self) -> dict:
        assert len(self.emf) == 1, f"EMF ドキュメントは 1 件のはず: {len(self.emf)}"
        return self.emf[0]

    def metric_names(self) -> list[str]:
        cw = self.document["_aws"]["CloudWatchMetrics"][0]
        return [m["Name"] for m in cw["Metrics"]]


# ── 検証エラーで弾く ─────────────────────────────────────────


class TestValidationRejects:
    @patch("index.sns")
    def test_severityが数値でないイベントは400で弾かれる(self, mock_sns):
        """結線前は get_severity_label の float 比較で TypeError になっていた経路。"""
        c = _Collected()

        result = lambda_handler(
            _make_event(severity="high"),
            MagicMock(),
            logger=c.logger,
            metrics=c.metrics,
        )

        assert result["statusCode"] == 400
        assert result["body"] == "Invalid event"
        mock_sns.publish.assert_not_called()

    @patch("index.sns")
    def test_必須フィールドが欠けたイベントは400で弾かれる(self, mock_sns):
        c = _Collected()

        result = lambda_handler(
            _make_event(title=None), MagicMock(), logger=c.logger, metrics=c.metrics
        )

        assert result["statusCode"] == 400
        mock_sns.publish.assert_not_called()

    @patch("index.sns")
    def test_弾いたときにFindingInvalidメトリクスが出る(self, mock_sns):
        c = _Collected()

        lambda_handler(
            _make_event(severity="high"),
            MagicMock(),
            logger=c.logger,
            metrics=c.metrics,
        )

        assert "FindingInvalid" in c.metric_names()
        assert c.document["FindingInvalid"] == 1

    @patch("index.sns")
    def test_warnログに落ちたフィールド名が載る(self, mock_sns):
        c = _Collected()

        lambda_handler(
            _make_event(accountId="abc"),
            MagicMock(),
            logger=c.logger,
            metrics=c.metrics,
        )

        entry = c.find_log("検証エラーのイベントをスキップ")
        assert entry is not None
        assert entry["level"] == "warn"
        assert entry["reason"] == "validation failed"
        assert entry["invalid_fields"] == ["accountId"]

    @patch("index.sns")
    def test_ログに不正な値そのものが出ない(self, mock_sns):
        """
        format_errors は accountId の実値をメッセージへ埋め込む。
        そのまま流すと logger.py のマスキングを迂回するため、
        フィールド名だけを載せる結線になっていることを確認する。
        """
        c = _Collected()

        # 12 桁の数字でないため検証エラーになる。値そのものは識別しやすい文字列にする。
        lambda_handler(
            _make_event(accountId="BADACCT00001"),
            MagicMock(),
            logger=c.logger,
            metrics=c.metrics,
        )

        dumped = json.dumps(c.logs, ensure_ascii=False)
        assert "BADACCT00001" not in dumped


# ── 警告では止めない ─────────────────────────────────────────


class TestValidationWarnings:
    @patch("index.sns")
    def test_推奨フィールドの欠落では通知を止めない(self, mock_sns):
        mock_sns.publish.return_value = {"MessageId": "msg-001"}
        c = _Collected()

        result = lambda_handler(
            _make_event(description=None),
            MagicMock(),
            logger=c.logger,
            metrics=c.metrics,
        )

        assert result["statusCode"] == 200
        mock_sns.publish.assert_called_once()

    @patch("index.sns")
    def test_警告時にFindingValidationWarningが出る(self, mock_sns):
        mock_sns.publish.return_value = {"MessageId": "msg-002"}
        c = _Collected()

        lambda_handler(
            _make_event(description=None),
            MagicMock(),
            logger=c.logger,
            metrics=c.metrics,
        )

        assert "FindingValidationWarning" in c.metric_names()
        entry = c.find_log("検証警告あり（通知は継続）")
        assert entry is not None
        assert entry["warning_fields"] == ["description"]

    @patch("index.sns")
    def test_正常なイベントは検証を通過してSNSへ送られる(self, mock_sns):
        mock_sns.publish.return_value = {"MessageId": "msg-003"}
        c = _Collected()

        result = lambda_handler(
            _make_event(), MagicMock(), logger=c.logger, metrics=c.metrics
        )

        assert result["statusCode"] == 200
        mock_sns.publish.assert_called_once()
        assert "FindingInvalid" not in c.metric_names()
        assert "FindingValidationWarning" not in c.metric_names()


# ── デプロイパッケージとの整合 ───────────────────────────────


class TestDeploymentPackage:
    def _packaged_files(self) -> set[str]:
        """
        archive_file の for_each に並んでいる .py を取り出す。

        ファイル全体を正規表現で舐めると、コメントアウトされた行や
        別ブロックの記述まで拾って「入っているつもり」になる。
        toset([...]) の中だけを見て、各行の # 以降も落とす。
        """
        tf = _SECURITY_TF.read_text(encoding="utf-8")
        block = re.search(
            r'data\s+"archive_file"\s+"guardduty_notifier".*?toset\(\[(.*?)\]\)',
            tf,
            re.DOTALL,
        )
        assert block is not None, "archive_file の toset ブロックが見つからない"

        entries = "\n".join(
            line.split("#", 1)[0] for line in block.group(1).splitlines()
        )
        return set(re.findall(r'"([A-Za-z_]+\.py)"', entries))

    def _local_modules_imported_by_index(self) -> set[str]:
        """index.py が import している同ディレクトリのモジュール名を集める。"""
        local = {
            path.stem
            for path in _HANDLER_DIR.glob("*.py")
            if not path.name.startswith("test_") and path.name != "conftest.py"
        }
        tree = ast.parse((_HANDLER_DIR / "index.py").read_text(encoding="utf-8"))
        imported: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module in local:
                imported.add(node.module)
            elif isinstance(node, ast.Import):
                imported.update(a.name for a in node.names if a.name in local)
        return imported

    def test_indexがimportする自作モジュールはすべてZIPに含まれている(self):
        """結線したのに archive_file へ追加し忘れる欠陥を防ぐ。"""
        packaged = self._packaged_files()
        missing = {
            f"{name}.py"
            for name in self._local_modules_imported_by_index()
            if f"{name}.py" not in packaged
        }

        assert not missing, f"デプロイ ZIP に含まれていない: {sorted(missing)}"

    def test_validatorsがZIPに含まれている(self):
        assert "validators.py" in self._packaged_files()
