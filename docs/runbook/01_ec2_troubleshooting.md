# Runbook: EC2 障害一次対応

## 目次

1. [EC2 に SSH / SSM 接続できない](#1-ec2-に-ssh--ssm-接続できない)
2. [EC2 CPU 使用率が高い](#2-ec2-cpu-使用率が高い)
3. [EC2 ステータスチェック失敗](#3-ec2-ステータスチェック失敗)

---

## 1. EC2 に SSH / SSM 接続できない

### 症状
- SSM Session Manager でセッションが開始できない
- `aws ssm start-session` がタイムアウトする

### 確認手順

#### Step 1: インスタンスの起動状態を確認
```bash
aws ec2 describe-instances \
  --instance-ids <インスタンスID> \
  --query "Reservations[].Instances[].State.Name" \
  --output text
```
- `running` → Step 2 へ
- `stopped` → EC2 を再起動して様子を見る
- `terminated` → 削除済み（Terraform で再作成が必要）

#### Step 2: SSM エージェントの状態確認
AWS コンソール → EC2 → インスタンスを選択 → **「接続」** タブ
- **Session Manager タブ**が表示されない場合 → IAM ロールに SSM ポリシーが付いていない可能性

#### Step 3: IAM ロール確認
```bash
aws ec2 describe-iam-instance-profile-associations \
  --filters "Name=instance-id,Values=<インスタンスID>"
```
- `AmazonSSMManagedInstanceCore` ポリシーが付与されているか確認

#### Step 4: セキュリティグループ確認
```bash
aws ec2 describe-security-groups \
  --group-ids <SGのID> \
  --query "SecurityGroups[].IpPermissions"
```
- SSM は HTTPS(443) のアウトバウンドが必要。インバウンドは不要。

### 判断基準

| 確認結果 | 対応 |
|---------|------|
| インスタンスが stopped | 再起動（原因調査後） |
| IAM ロールなし | Terraform で `aws_iam_role_policy_attachment` を追加 |
| SG でアウトバウンド 443 がブロック | SG ルールを修正 |
| SSM エージェント未起動 | EC2 コンソールからリブート |

---

## 2. EC2 CPU 使用率が高い

### 症状
- CloudWatch アラーム「ec2-cpu」が ALARM 状態
- CPU 使用率が継続して 80% 以上

### 確認手順

#### Step 1: CloudWatch でグラフ確認
AWS コンソール → CloudWatch → メトリクス → EC2 → CPUUtilization
- 急上昇か、じわじわ上昇か確認

#### Step 2: プロセス確認（SSM Session Manager で接続）
```bash
# CPU 使用率上位プロセス
top -bn1 | head -20

# Apache の状態
sudo systemctl status httpd

# メモリ確認
free -h
```

#### Step 3: アクセスログ確認（Apache）
```bash
sudo tail -100 /var/log/httpd/access_log | awk '{print $1}' | sort | uniq -c | sort -rn | head -10
```
- 特定 IP からの大量アクセス → ALB の WAF 設定を検討

### 判断基準

| 確認結果 | 対応 |
|---------|------|
| 特定プロセスが暴走 | プロセス再起動（`sudo systemctl restart httpd`） |
| 大量アクセス（DDoS 疑い） | ALB の IP 制限 / WAF を追加 |
| 正常な負荷増大 | EC2 スケールアップ or Auto Scaling 検討 |
| 原因不明 | インスタンスを再起動してログを取得 |

---

## 3. EC2 ステータスチェック失敗

### 症状
- CloudWatch アラーム「ec2-status」が ALARM 状態
- AWS コンソールで「ステータスチェック失敗」と表示

### 確認手順

#### Step 1: ステータスチェックの種類を確認
AWS コンソール → EC2 → インスタンス → **「ステータスチェック」タブ**

| チェック種類 | 意味 |
|------------|------|
| System status check 失敗 | AWS ハードウェア側の問題 |
| Instance status check 失敗 | OS・ソフトウェア側の問題 |

#### Step 2: System status check 失敗の場合
```
対応: インスタンスを停止 → 起動（Stop → Start）
※ 再起動（Reboot）ではなく Stop → Start にすること
  → Stop → Start で別ホストに移動されるため AWS 側の問題を回避できる
```

#### Step 3: Instance status check 失敗の場合
- コンソールのスクリーンショット確認:
  AWS コンソール → EC2 → インスタンスを選択 → **「アクション」→「モニタリングとトラブルシューティング」→「システムログの取得」**

### 判断基準

| 確認結果 | 対応 | エスカレーション |
|---------|------|----------------|
| System status check 失敗 | Stop → Start | 解消しなければ AWS サポートへ |
| Instance status check 失敗 | リブート → ログ確認 | OS 復旧不可なら AMI から再作成 |
| 両方失敗 | Stop → Start | 解消しなければ上長に報告 |

---

## 自分で判断できる範囲 / 相談すべき範囲

| 操作 | 判断 |
|-----|------|
| SSM でのログ・プロセス確認 | 自分で実施 OK |
| EC2 の再起動（Reboot） | 自分で実施 OK（影響: 数十秒の停止） |
| EC2 の Stop → Start | **上長に確認推奨**（IP アドレスが変わる可能性） |
| SG・IAM の変更 | **必ずレビューを受ける** |
| インスタンスの削除・再作成 | **上長・チームの承認必須** |
