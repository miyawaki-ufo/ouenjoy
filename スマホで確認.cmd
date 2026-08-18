@echo off
chcp 65001 > nul
cd /d "%~dp0"
title ウェルカムマッチ応援アプリ - プレビュー

echo.
echo  ============================================
echo   ウェルカムマッチ応援アプリ プレビュー
echo  ============================================
echo.

where python > nul 2>&1
if errorlevel 1 (
  echo  [!] Python が見つかりませんでした。
  echo.
  echo      かわりに index.html をダブルクリックすれば
  echo      パソコンのブラウザでは確認できます。
  echo      スマホで見たい場合は Python が必要です。
  echo.
  pause
  exit /b 1
)

echo  このパソコンのアドレスを調べています...
echo.

for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr /c:"IPv4"') do (
  for /f "tokens=* delims= " %%B in ("%%A") do (
    echo    スマホで開く: http://%%B:8123/
  )
)

echo.
echo    このパソコンで開く: http://localhost:8123/
echo.
echo  ============================================
echo   スマホでの確認方法
echo  ============================================
echo.
echo   1. スマホをこのパソコンと同じ Wi-Fi につなぐ
echo   2. スマホのブラウザに、上の「スマホで開く」の
echo      アドレスを入力する
echo   3. 実際の見え方・押しやすさを確認する
echo.
echo   ※ 会社や大学の Wi-Fi では、機器どうしの通信が
echo      禁止されていてつながらないことがあります。
echo      その場合は、公開してから確認してください。
echo.
echo  ============================================
echo   終わるときは、この黒い画面で Ctrl + C
echo  ============================================
echo.

start "" http://localhost:8123/
python -m http.server 8123
