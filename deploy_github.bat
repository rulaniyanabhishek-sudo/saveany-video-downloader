@echo off
set GIT="C:\Program Files\Git\bin\git.exe"
set GH="C:\Program Files\GitHub CLI\gh.exe"

cd /d "C:\Users\ABHISHEK\.gemini\antigravity\scratch\video-downloader"

echo [1/6] Initializing git repo...
%GIT% init
%GIT% config user.email "deploy@saveany.com"
%GIT% config user.name "ABHISHEK RULANIYA"

echo [2/6] Creating .gitignore...
echo node_modules/ > .gitignore
echo bin/ >> .gitignore
echo tmp/ >> .gitignore
echo .vercel/ >> .gitignore

echo [3/6] Staging all files...
%GIT% add -A

echo [4/6] Committing...
%GIT% commit -m "Initial commit: SaveAny Video Downloader"

echo [5/6] Creating GitHub repo...
%GH% repo create saveany-video-downloader --public --source=. --remote=origin --push

echo [6/6] Done!
echo SUCCESS
