@echo off
chcp 65001 >nul
rem Windows: bấm đúp để chạy iPre trên máy này + mở qua Cloudflare. Xem docs\08-chay-tai-may-cloudflare.md
cd /d "%~dp0"
where node >nul 2>nul || (echo Chua cai Node.js 22+ - tai o https://nodejs.org roi bam dup lai. & pause & exit /b 1)
if not exist node_modules (call npm install || (pause & exit /b 1))
call npx tsx scripts\chay-tai-may.ts --cloudflare %*
echo iPre da dung.
pause
