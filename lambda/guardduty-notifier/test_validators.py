"""
GuardDuty Finding バリデーター ユニットテスト
"""

from validators import (
    GUARDDUTY_DETAIL_TYPE,
    GUARDDUTY_EVENT_SOURCE,
    MAX_SEVERITY,
    MAX_SNS_MESSAGE_BYTES,
    MAX_SNS_SUBJECT_LENGTH,
    MIN_SEVERITY,
    RECOMMENDED_DETAIL_FIELDS,
    REQUIRED_DETAIL_FIELDS,
    SEVERITY_THRESHOLDS,
    VALID_AWS_REGIONS,
    ValidationError,
    classify_severity,
    format_errors,
    has_errors,
    is_alertable_severity,
    is_known_region,
    is_valid_account_id,
    is_valid_finding_type,
    is_valid_region,
    is_valid_severity,
    validate_account_id,
    validate_event_envelope,
    validate_finding_detail,
    validate_finding_type,
    validate_guardduty_event,
    validate_region,
    validate_severity,
    validate_sns_message,
    validate_sns_subject,
)

# ── ヘルパー ─────────────────────────────────────────────────


def _make_detail(**overrides) -> dict:
    base = {
        "severity": 7.5,
        "type": "UnauthorizedAccess:EC2/SSHBruteForce",
        "title": "SSH Brute Force Attack",
        "description": "不審なSSHアクセスを検出",
        "region": "ap-northeast-1",
        "accountId": "123456789012",
        "id": "abcdef1234567890abcdef1234567890",
    }
    base.update(overrides)
    return base


def _make_event(**detail_overrides) -> dict:
    return {
        "source": GUARDDUTY_EVENT_SOURCE,
        "detail-type": GUARDDUTY_DETAIL_TYPE,
        "detail": _make_detail(**detail_overrides),
    }


# ── 定数テスト ───────────────────────────────────────────────


class TestConstants:
    def test_event_source(self):
        assert GUARDDUTY_EVENT_SOURCE == "aws.guardduty"

    def test_detail_type(self):
        assert GUARDDUTY_DETAIL_TYPE == "GuardDuty Finding"

    def test_severity_range(self):
        assert MIN_SEVERITY == 0.0
        assert MAX_SEVERITY == 10.0

    def test_severity_thresholds(self):
        assert SEVERITY_THRESHOLDS["CRITICAL"] == 9.0
        assert SEVERITY_THRESHOLDS["HIGH"] == 7.0
        assert SEVERITY_THRESHOLDS["MEDIUM"] == 4.0
        assert SEVERITY_THRESHOLDS["LOW"] == 0.0

    def test_required_fields(self):
        assert "severity" in REQUIRED_DETAIL_FIELDS
        assert "type" in REQUIRED_DETAIL_FIELDS
        assert "title" in REQUIRED_DETAIL_FIELDS

    def test_recommended_fields(self):
        assert "region" in RECOMMENDED_DETAIL_FIELDS
        assert "accountId" in RECOMMENDED_DETAIL_FIELDS

    def test_sns_constraints(self):
        assert MAX_SNS_SUBJECT_LENGTH == 100
        assert MAX_SNS_MESSAGE_BYTES == 256 * 1024

    def test_valid_regions(self):
        assert "ap-northeast-1" in VALID_AWS_REGIONS
        assert "us-east-1" in VALID_AWS_REGIONS


# ── 重大度バリデーション ──────────────────────────────────────


class TestIsValidSeverity:
    def test_有効な範囲(self):
        assert is_valid_severity(0.0) is True
        assert is_valid_severity(5.0) is True
        assert is_valid_severity(10.0) is True

    def test_範囲外(self):
        assert is_valid_severity(-0.1) is False
        assert is_valid_severity(10.1) is False


class TestClassifySeverity:
    def test_CRITICAL(self):
        assert classify_severity(9.0) == "CRITICAL"
        assert classify_severity(10.0) == "CRITICAL"

    def test_HIGH(self):
        assert classify_severity(7.0) == "HIGH"
        assert classify_severity(8.9) == "HIGH"

    def test_MEDIUM(self):
        assert classify_severity(4.0) == "MEDIUM"
        assert classify_severity(6.9) == "MEDIUM"

    def test_LOW(self):
        assert classify_severity(0.0) == "LOW"
        assert classify_severity(3.9) == "LOW"


class TestIsAlertableSeverity:
    def test_閾値以上(self):
        assert is_alertable_severity(4.0) is True
        assert is_alertable_severity(7.5) is True

    def test_閾値未満(self):
        assert is_alertable_severity(3.9) is False

    def test_カスタム閾値(self):
        assert is_alertable_severity(6.9, threshold=7.0) is False
        assert is_alertable_severity(7.0, threshold=7.0) is True


class TestValidateSeverity:
    def test_有効な重大度でエラーなし(self):
        assert validate_severity(7.5) == []

    def test_整数でも有効(self):
        assert validate_severity(8) == []

    def test_文字列はエラー(self):
        errors = validate_severity("high")
        assert any(e.severity == "error" for e in errors)

    def test_範囲外はエラー(self):
        errors = validate_severity(11.0)
        assert any(e.severity == "error" for e in errors)

    def test_0はwarning(self):
        errors = validate_severity(0.0)
        assert any(e.severity == "warning" for e in errors)

    def test_負の値はエラー(self):
        errors = validate_severity(-1.0)
        assert any(e.severity == "error" for e in errors)


# ── Finding Type バリデーション ───────────────────────────────


class TestIsValidFindingType:
    def test_有効なフォーマット(self):
        assert is_valid_finding_type("UnauthorizedAccess:EC2/SSHBruteForce") is True
        assert is_valid_finding_type("Recon:EC2/PortProbeUnprotectedPort") is True

    def test_スラッシュなしは無効(self):
        assert is_valid_finding_type("UnauthorizedAccess:EC2") is False

    def test_コロンなしは無効(self):
        assert is_valid_finding_type("UnauthorizedAccess") is False

    def test_空文字は無効(self):
        assert is_valid_finding_type("") is False


class TestValidateFindingType:
    def test_有効な型でエラーなし(self):
        assert validate_finding_type("UnauthorizedAccess:EC2/SSHBruteForce") == []

    def test_空文字でエラー(self):
        errors = validate_finding_type("")
        assert any(e.severity == "error" for e in errors)

    def test_数値はエラー(self):
        errors = validate_finding_type(123)
        assert any(e.severity == "error" for e in errors)

    def test_不正フォーマットはwarning(self):
        errors = validate_finding_type("InvalidFormat")
        assert any(e.severity == "warning" for e in errors)


# ── AWS リソースバリデーション ────────────────────────────────


class TestIsValidRegion:
    def test_有効なリージョン(self):
        assert is_valid_region("ap-northeast-1") is True
        assert is_valid_region("us-east-1") is True

    def test_無効なフォーマット(self):
        assert is_valid_region("tokyo") is False
        assert is_valid_region("") is False


class TestIsKnownRegion:
    def test_既知のリージョン(self):
        assert is_known_region("ap-northeast-1") is True

    def test_未知のリージョン(self):
        assert is_known_region("xx-unknown-1") is False


class TestValidateRegion:
    def test_有効なリージョンでエラーなし(self):
        assert validate_region("ap-northeast-1") == []

    def test_空文字でエラー(self):
        errors = validate_region("")
        assert any(e.severity == "error" for e in errors)

    def test_Noneでエラー(self):
        errors = validate_region(None)
        assert any(e.severity == "error" for e in errors)

    def test_無効なフォーマットでエラー(self):
        errors = validate_region("tokyo")
        assert any(e.severity == "error" for e in errors)

    def test_未知のリージョンでwarning(self):
        errors = validate_region("af-south-1")
        assert any(e.severity == "warning" for e in errors)


class TestIsValidAccountId:
    def test_有効な12桁(self):
        assert is_valid_account_id("123456789012") is True

    def test_11桁は無効(self):
        assert is_valid_account_id("12345678901") is False

    def test_13桁は無効(self):
        assert is_valid_account_id("1234567890123") is False

    def test_文字混じりは無効(self):
        assert is_valid_account_id("12345678901a") is False


class TestValidateAccountId:
    def test_有効なIDでエラーなし(self):
        assert validate_account_id("123456789012") == []

    def test_空でエラー(self):
        errors = validate_account_id("")
        assert any(e.severity == "error" for e in errors)

    def test_不正なフォーマットでエラー(self):
        errors = validate_account_id("abc")
        assert any(e.severity == "error" for e in errors)

    def test_Noneでエラー(self):
        errors = validate_account_id(None)
        assert any(e.severity == "error" for e in errors)


# ── EventBridge イベントバリデーション ────────────────────────


class TestValidateEventEnvelope:
    def test_有効なイベントでエラーなし(self):
        assert validate_event_envelope(_make_event()) == []

    def test_dictでない入力はエラー(self):
        errors = validate_event_envelope("not-a-dict")
        assert any(e.severity == "error" for e in errors)

    def test_detail未定義でエラー(self):
        event = {"source": GUARDDUTY_EVENT_SOURCE}
        errors = validate_event_envelope(event)
        assert any(e.field == "detail" and e.severity == "error" for e in errors)

    def test_detail空でエラー(self):
        event = {"source": GUARDDUTY_EVENT_SOURCE, "detail": {}}
        errors = validate_event_envelope(event)
        assert any(e.field == "detail" for e in errors)

    def test_detailがdictでないとエラー(self):
        event = {"source": GUARDDUTY_EVENT_SOURCE, "detail": "string"}
        errors = validate_event_envelope(event)
        assert any(e.field == "detail" for e in errors)

    def test_source不一致でwarning(self):
        event = _make_event()
        event["source"] = "aws.other"
        errors = validate_event_envelope(event)
        assert any(e.field == "source" and e.severity == "warning" for e in errors)

    def test_detail_type不一致でwarning(self):
        event = _make_event()
        event["detail-type"] = "Other Type"
        errors = validate_event_envelope(event)
        assert any(e.field == "detail-type" and e.severity == "warning" for e in errors)

    def test_sourceなしは許容(self):
        event = {"detail": _make_detail()}
        errors = validate_event_envelope(event)
        assert not any(e.field == "source" for e in errors)


# ── Finding Detail バリデーション ─────────────────────────────


class TestValidateFindingDetail:
    def test_全フィールド揃いでエラーなし(self):
        errors = validate_finding_detail(_make_detail())
        assert errors == []

    def test_severity欠落でエラー(self):
        detail = _make_detail()
        del detail["severity"]
        errors = validate_finding_detail(detail)
        assert any(e.field == "severity" and e.severity == "error" for e in errors)

    def test_type欠落でエラー(self):
        detail = _make_detail()
        del detail["type"]
        errors = validate_finding_detail(detail)
        assert any(e.field == "type" and e.severity == "error" for e in errors)

    def test_title欠落でエラー(self):
        detail = _make_detail()
        del detail["title"]
        errors = validate_finding_detail(detail)
        assert any(e.field == "title" and e.severity == "error" for e in errors)

    def test_title空文字でエラー(self):
        errors = validate_finding_detail(_make_detail(title=""))
        assert any(e.field == "title" and e.severity == "error" for e in errors)

    def test_region欠落でwarning(self):
        detail = _make_detail()
        del detail["region"]
        errors = validate_finding_detail(detail)
        assert any(e.field == "region" and e.severity == "warning" for e in errors)

    def test_accountId欠落でwarning(self):
        detail = _make_detail()
        del detail["accountId"]
        errors = validate_finding_detail(detail)
        assert any(e.field == "accountId" and e.severity == "warning" for e in errors)

    def test_無効なseverityでエラー(self):
        errors = validate_finding_detail(_make_detail(severity="high"))
        assert any(e.field == "severity" and e.severity == "error" for e in errors)

    def test_無効なregionでエラー(self):
        errors = validate_finding_detail(_make_detail(region="invalid"))
        assert any(e.field == "region" and e.severity == "error" for e in errors)

    def test_無効なaccountIdでエラー(self):
        errors = validate_finding_detail(_make_detail(accountId="abc"))
        assert any(e.field == "accountId" and e.severity == "error" for e in errors)


# ── SNS メッセージバリデーション ──────────────────────────────


class TestValidateSnsSubject:
    def test_有効な件名(self):
        assert validate_sns_subject("[GuardDuty] [HIGH] SSH Brute Force") == []

    def test_空でエラー(self):
        errors = validate_sns_subject("")
        assert any(e.severity == "error" for e in errors)

    def test_スペースのみでエラー(self):
        errors = validate_sns_subject("   ")
        assert any(e.severity == "error" for e in errors)

    def test_100文字超えでwarning(self):
        errors = validate_sns_subject("A" * 101)
        assert any(e.severity == "warning" for e in errors)

    def test_ちょうど100文字はOK(self):
        assert validate_sns_subject("A" * 100) == []


class TestValidateSnsMessage:
    def test_有効な本文(self):
        assert validate_sns_message("GuardDuty セキュリティアラート") == []

    def test_空でエラー(self):
        errors = validate_sns_message("")
        assert any(e.severity == "error" for e in errors)

    def test_256KB超えでエラー(self):
        errors = validate_sns_message("A" * (MAX_SNS_MESSAGE_BYTES + 1))
        assert any(e.field == "message" and e.severity == "error" for e in errors)


# ── 統合バリデーション ────────────────────────────────────────


class TestValidateGuarddutyEvent:
    def test_有効なイベントでエラーなし(self):
        assert validate_guardduty_event(_make_event()) == []

    def test_detail空で早期リターン(self):
        event = {"detail": {}}
        errors = validate_guardduty_event(event)
        assert any(e.severity == "error" for e in errors)

    def test_detailなしで早期リターン(self):
        event = {}
        errors = validate_guardduty_event(event)
        assert any(e.field == "detail" for e in errors)

    def test_detail内のエラーも集約される(self):
        event = _make_event(severity="invalid", region="bad")
        errors = validate_guardduty_event(event)
        assert any(e.field == "severity" for e in errors)
        assert any(e.field == "region" for e in errors)


# ── ユーティリティ ────────────────────────────────────────────


class TestHasErrors:
    def test_errorあり(self):
        errors = [ValidationError(field="x", message="err", severity="error")]
        assert has_errors(errors) is True

    def test_warningのみ(self):
        errors = [ValidationError(field="x", message="warn", severity="warning")]
        assert has_errors(errors) is False

    def test_空(self):
        assert has_errors([]) is False


class TestFormatErrors:
    def test_空は成功メッセージ(self):
        assert format_errors([]) == "すべてのチェックが通過しました"

    def test_フォーマット(self):
        errors = [
            ValidationError(field="x", message="問題", severity="error"),
            ValidationError(field="y", message="注意", severity="warning"),
        ]
        result = format_errors(errors)
        assert "[ERROR] x: 問題" in result
        assert "[WARNING] y: 注意" in result
