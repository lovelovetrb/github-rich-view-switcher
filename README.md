# GitHub Rich View Switcher

GitHub の PR / commit / compare の差分画面で、どれか 1 ファイルの表示を
**rich diff**（📄）または **source diff**（`<>`）に切り替えると、
ページ内で切り替えられる他のファイルもすべて同じ表示に揃える Chrome 拡張です。

新しいボタンは追加せず、GitHub にもともとあるトグルの挙動を変えるだけです。

- 後から読み込まれたファイル（遅延ロード・仮想スクロール）にも同じ表示を適用します
- 選んだ表示は同じ PR の中だけで有効です（別の PR に移るとリセットされます）
- 旧 UI（Files changed）と新 UI（React 版の Files changed）の両方に対応しています

## インストール

1. `chrome://extensions` を開く
2. 右上の「デベロッパー モード」を ON にする
3. 「パッケージ化されていない拡張機能を読み込む」でこのリポジトリのディレクトリを選ぶ

## 仕組み

| UI | トグル | 状態の判定 |
| --- | --- | --- |
| 旧 UI | `.js-prose-diff-toggle-form` 内の `button.js-rendered` / `button.js-source` | ファイルコンテナ（`.js-details-container`）の `display-rich-diff` クラス |
| 新 UI | `ul[data-component="SegmentedControl"]` 内のボタン（ラベルは Tooltip の `aria-labelledby` 経由で `Display the rich diff` / `Display the source diff`） | ボタンの `aria-pressed` |

ユーザーの実際のクリック（`event.isTrusted`）を検知したら、状態が違う他のファイルのボタンを
プログラムから `click()` します。旧 UI はファイルごとに通信が発生するため、同時に処理する数を 4 件に抑えています。

旧 UI の GitHub 側ハンドラは、クリックのたびにページ内すべてのトグルの `selected` を外し、URL も書き換えます。
そのため拡張側でボタンの選択状態と URL を元に戻しています。
