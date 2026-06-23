name: India HVAC Crawler

# 매주 월요일 새벽 2시(한국시간)에 자동으로 실행 (UTC 일요일 17:00)
on:
  schedule:
    - cron: '0 17 * * 0'
  workflow_dispatch: # 웹에서 수동으로 실행하고 싶을 때 쓰는 버튼 활성화

jobs:
  scrape_india:
    runs-on: ubuntu-latest

    steps:
    - name: 코드 가져오기
      uses: actions/checkout@v4

    - name: Node.js 세팅
      uses: actions/setup-node@v4
      with:
        node-version: '20'

    - name: 패키지 및 브라우저 설치
      run: |
        npm install
        npx playwright install chromium --with-deps

    - name: 크롤러 실행
      run: node india_crawler.js
