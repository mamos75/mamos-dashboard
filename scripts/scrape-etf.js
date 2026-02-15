#!/usr/bin/env node
/**
 * ETF FLOWS SCRAPER - Farside.co.uk
 * Runs daily after US market close (22:00 UTC / 06:00 WITA)
 * Bypasses Cloudflare with real browser
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const CACHE_PATH = path.join(__dirname, '..', '.etf-cache.json');
const URL = 'https://farside.co.uk/?p=997';

// Parse Farside number format: (xxx) = negative, xxx = positive
function parseNumber(text) {
  if (!text || text === '-' || text === '') return 0;
  const cleaned = text.trim().replace(/[$,\s]/g, '');
  const isNegative = cleaned.startsWith('(') && cleaned.endsWith(')');
  const value = parseFloat(cleaned.replace(/[()]/g, ''));
  if (isNaN(value)) return 0;
  return isNegative ? -value : value;
}

async function scrapeETFFlows() {
  console.log('🚀 Starting ETF scraper...');
  
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    console.log('📄 Loading Farside page...');
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('table', { timeout: 10000 });
    
    console.log('🔍 Extracting data...');
    
    const data = await page.evaluate(() => {
      const tables = document.querySelectorAll('table');
      let etfTable = null;
      
      // Find main ETF table (contains IBIT and date rows)
      for (const table of tables) {
        const text = table.innerText;
        if (text.includes('IBIT') && text.includes('FBTC') && text.includes('Jan') || text.includes('Feb')) {
          etfTable = table;
          break;
        }
      }
      
      if (!etfTable) return null;
      
      const rows = Array.from(etfTable.querySelectorAll('tr'));
      const dailyData = [];
      
      // Process each row looking for date rows
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td, th'));
        if (cells.length < 3) continue;
        
        const firstCell = cells[0]?.innerText?.trim() || '';
        
        // Check if this is a date row (format: "27 Jan 2026" or "14 Feb 2026")
        const dateMatch = firstCell.match(/(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})/i);
        
        if (dateMatch) {
          // Get the last cell (Total column)
          const totalCell = cells[cells.length - 1]?.innerText?.trim() || '0';
          
          dailyData.push({
            date: firstCell,
            totalRaw: totalCell
          });
        }
      }
      
      return dailyData;
    });
    
    if (!data || data.length === 0) {
      throw new Error('Could not parse ETF table');
    }
    
    // Parse the extracted data
    const parsedData = data.map(d => ({
      date: d.date,
      total: parseNumber(d.totalRaw)
    }));
    
    // Get most recent days (data is chronological, most recent at bottom)
    const recentDays = parsedData.slice(-10);
    const latestDay = recentDays[recentDays.length - 1];
    const last5Days = recentDays.slice(-5);
    const weeklyTotal = last5Days.reduce((sum, d) => sum + d.total, 0);
    
    console.log('📊 Recent daily flows (oldest to newest):');
    last5Days.forEach(d => console.log(`   ${d.date}: ${d.total > 0 ? '+' : ''}${d.total.toFixed(1)}M`));
    
    const result = {
      fetchDate: new Date().toISOString().split('T')[0],
      fetchTime: new Date().toISOString(),
      data: {
        date: latestDay.date,
        daily: Math.round(latestDay.total * 10) / 10,
        weekly: Math.round(weeklyTotal * 10) / 10,
        dailyHistory: last5Days.map(d => ({ date: d.date, flow: Math.round(d.total * 10) / 10 })),
        trend: latestDay.total > 0 ? 'positive_daily' : 'negative_daily',
        source: 'farside'
      }
    };
    
    // Save to cache
    fs.writeFileSync(CACHE_PATH, JSON.stringify(result, null, 2));
    console.log('✅ ETF data saved!');
    console.log(`   Latest: ${latestDay.date} → ${latestDay.total > 0 ? '+' : ''}${latestDay.total.toFixed(1)}M`);
    console.log(`   Weekly (5d): ${weeklyTotal > 0 ? '+' : ''}${weeklyTotal.toFixed(1)}M`);
    
    return result;
    
  } catch (error) {
    console.error('❌ Scraper error:', error.message);
    
    if (fs.existsSync(CACHE_PATH)) {
      console.log('📦 Using cached data');
      return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    }
    
    throw error;
  } finally {
    if (browser) await browser.close();
  }
}

if (require.main === module) {
  scrapeETFFlows()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = { scrapeETFFlows };
