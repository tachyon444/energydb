{
  "name": "hvac-india-crawler",
  "version": "2.0.0",
  "private": true,
  "description": "India BEE HVAC crawler using Export PDF Approval Date -> Google Apps Script doPost",
  "main": "india_crawler.js",
  "scripts": {
    "start": "node india_crawler.js"
  },
  "dependencies": {
    "pdf-parse": "^1.1.1",
    "playwright": "^1.55.0",
    "playwright-extra": "^4.3.6",
    "puppeteer-extra-plugin-stealth": "^2.11.2"
  }
}
