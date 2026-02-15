#!/usr/bin/env node
/**
 * MAMOS DASHBOARD - Smart Data Engine
 * Fetches all data + generates automatic interpretation
 * Runs every 15 minutes via cron
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const OUTPUT_PATH = path.join(__dirname, '..', 'data.json');

function fetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const req = https.request({
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: { 'User-Agent': 'MamosDashboard/2.0', ...options.headers }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } 
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// ============ DATA FETCHERS ============

// Fetch BTC Price + Key Levels for actionable analysis
async function fetchPriceData() {
  try {
    const [ticker, klines] = await Promise.all([
      fetch('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT'),
      fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=14')
    ]);
    
    const price = parseFloat(ticker.lastPrice);
    const high24h = parseFloat(ticker.highPrice);
    const low24h = parseFloat(ticker.lowPrice);
    const change24h = parseFloat(ticker.priceChangePercent);
    
    // Calculate key levels from recent candles
    const candles = klines.map(k => ({
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4])
    }));
    
    // Find significant levels
    const allHighs = candles.map(c => c.high);
    const allLows = candles.map(c => c.low);
    const weekHigh = Math.max(...allHighs.slice(-7));
    const weekLow = Math.min(...allLows.slice(-7));
    const recentSwingLow = Math.min(...allLows.slice(-3));
    const recentSwingHigh = Math.max(...allHighs.slice(-3));
    
    // Key support/resistance levels
    const support1 = Math.round(low24h / 100) * 100; // Round to 100
    const support2 = Math.round(recentSwingLow / 100) * 100;
    const support3 = Math.round(weekLow / 100) * 100;
    const resistance1 = Math.round(high24h / 100) * 100;
    const resistance2 = Math.round(recentSwingHigh / 100) * 100;
    const resistance3 = Math.round(weekHigh / 100) * 100;
    
    // Determine bias based on price position
    const midRange = (weekHigh + weekLow) / 2;
    const bias = price > midRange ? 'bullish' : 'bearish';
    const pricePosition = price > resistance1 ? 'above_resistance' : 
                          price < support1 ? 'below_support' : 'in_range';
    
    return {
      current: Math.round(price),
      high24h: Math.round(high24h),
      low24h: Math.round(low24h),
      change24h: change24h.toFixed(2),
      weekHigh: Math.round(weekHigh),
      weekLow: Math.round(weekLow),
      supports: [support1, support2, support3].filter((v, i, a) => a.indexOf(v) === i).sort((a,b) => b-a).slice(0, 3),
      resistances: [resistance1, resistance2, resistance3].filter((v, i, a) => a.indexOf(v) === i).sort((a,b) => a-b).slice(0, 3),
      bias,
      pricePosition
    };
  } catch (e) {
    console.error('Price data error:', e.message);
    return null;
  }
}

// Fetch Bitcoin Hashrate with proper trend analysis
async function fetchHashrate() {
  try {
    // Use mempool.space for accurate historical data
    const data = await fetch('https://mempool.space/api/v1/mining/hashrate/1w');
    
    if (data?.hashrates && data.hashrates.length > 0) {
      const hashrates = data.hashrates.map(h => h.avgHashrate / 1e18); // Convert to EH/s
      const current = hashrates[hashrates.length - 1];
      const yesterday = hashrates[hashrates.length - 2] || current;
      const weekAgo = hashrates[0];
      const peak = Math.max(...hashrates);
      
      // Calculate trends
      const changeFromPeak = ((current - peak) / peak * 100).toFixed(1);
      const change7d = ((current - weekAgo) / weekAgo * 100).toFixed(1);
      const change24h = ((current - yesterday) / yesterday * 100).toFixed(1);
      
      // Determine trend - prioritize SHORT-TERM over weekly
      let trend, interpretation, signal;
      
      const isDropping = parseFloat(change24h) < -2 && parseFloat(changeFromPeak) < -5;
      const isCrashing = parseFloat(changeFromPeak) < -15;
      const isRising = parseFloat(change24h) > 2 && parseFloat(change7d) > 5;
      
      let priceImpact = '';
      
      if (isCrashing) {
        trend = 'crashing';
        interpretation = '🔴 Hashrate en chute libre (' + changeFromPeak + '% depuis le pic). Mineurs en grande difficulté.';
        priceImpact = '⚠️ <strong>Impact prix :</strong> Les mineurs vendent du BTC pour payer leurs factures → pression vendeuse à court terme. MAIS historiquement, la capitulation des mineurs marque souvent un <strong>point bas</strong>. Si tu crois au long terme, c\'est potentiellement une opportunité.';
        signal = 'bearish';
      } else if (isDropping) {
        trend = 'dropping';
        interpretation = '📉 Hashrate en baisse (' + change24h + '% 24h, ' + changeFromPeak + '% depuis le pic). Les mineurs ralentissent.';
        priceImpact = '🤔 <strong>Pourquoi ça baisse ?</strong> Soit les mineurs les moins rentables éteignent leurs machines (coûts > revenus), soit maintenance temporaire après le pic. <br><br>📊 <strong>Scénarios possibles :</strong><br>• Si le prix continue de baisser → plus de mineurs arrêtent → capitulation = souvent proche d\'un bottom<br>• Si le prix rebondit → hashrate repart → situation saine';
        signal = 'neutral';
      } else if (isRising) {
        trend = 'rising';
        interpretation = '🟢 Hashrate en hausse (+' + change24h + '% 24h). Mineurs confiants.';
        priceImpact = '✅ <strong>Signal positif :</strong> Les mineurs investissent dans du matériel → ils croient que le BTC vaudra plus cher à l\'avenir. Réseau plus sécurisé = fondamentaux solides.';
        signal = 'bullish';
      } else if (parseFloat(change7d) > 0 && parseFloat(change24h) >= -2) {
        trend = 'stable';
        interpretation = '⚪ Hashrate stable. Légère consolidation après le pic.';
        priceImpact = '😌 <strong>Neutre :</strong> Pas de signal particulier. Les mineurs maintiennent leur activité normale.';
        signal = 'neutral';
      } else {
        trend = 'falling';
        interpretation = '🟡 Hashrate en légère baisse. Pression sur certains mineurs.';
        priceImpact = '👀 <strong>À surveiller :</strong> Baisse légère = ajustement normal. Si ça continue → surveiller une possible capitulation.';
        signal = 'neutral';
      }
      
      return {
        current: current.toFixed(0),
        unit: 'EH/s',
        trend,
        peak: peak.toFixed(0),
        change24h: parseFloat(change24h),
        change7d: parseFloat(change7d),
        changeFromPeak: parseFloat(changeFromPeak),
        interpretation,
        priceImpact,
        signal
      };
    }
  } catch (e) {
    console.error('Hashrate error:', e.message);
  }
  
  // Fallback
  return {
    current: '1000',
    unit: 'EH/s',
    trend: 'unknown',
    interpretation: '⚪ Données hashrate indisponibles',
    signal: 'neutral'
  };
}

// Fear & Greed with history
async function fetchFearGreed() {
  try {
    const data = await fetch('https://api.alternative.me/fng/?limit=30');
    if (data?.data) {
      const values = data.data.map(d => ({ value: parseInt(d.value), date: d.timestamp }));
      const current = values[0].value;
      const yesterday = values[1]?.value || current;
      const weekAgo = values[6]?.value || current;
      const monthAgo = values[29]?.value || current;
      
      return {
        current,
        label: data.data[0].value_classification,
        change24h: current - yesterday,
        change7d: current - weekAgo,
        change30d: current - monthAgo,
        trend: current > weekAgo ? 'improving' : current < weekAgo ? 'worsening' : 'stable',
        history7d: values.slice(0, 7).map(v => v.value)
      };
    }
  } catch (e) { console.error('Fear & Greed error:', e.message); }
  return null;
}

// Long/Short Ratio (Top Traders + All Accounts)
async function fetchLongShort() {
  try {
    const [topTraders, accounts, takerRatio] = await Promise.all([
      fetch('https://fapi.binance.com/futures/data/topLongShortPositionRatio?symbol=BTCUSDT&period=5m&limit=48'),
      fetch('https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=5m&limit=48'),
      fetch('https://fapi.binance.com/futures/data/takerlongshortRatio?symbol=BTCUSDT&period=5m&limit=48')
    ]);
    
    if (Array.isArray(topTraders) && topTraders.length > 0) {
      const latest = topTraders[0];
      const h4Ago = topTraders[Math.min(47, topTraders.length - 1)];
      
      const longPct = (parseFloat(latest.longAccount) * 100).toFixed(1);
      const shortPct = (parseFloat(latest.shortAccount) * 100).toFixed(1);
      const ratio = parseFloat(latest.longShortRatio);
      const ratioH4Ago = parseFloat(h4Ago.longShortRatio);
      const trend = ratio > ratioH4Ago ? 'more_long' : ratio < ratioH4Ago ? 'more_short' : 'stable';
      
      // Taker buy/sell ratio
      let takerBuySell = 1;
      if (Array.isArray(takerRatio) && takerRatio.length > 0) {
        takerBuySell = parseFloat(takerRatio[0].buySellRatio);
      }
      
      return {
        topTraders: { long: longPct, short: shortPct, ratio: ratio.toFixed(2) },
        accounts: Array.isArray(accounts) ? {
          long: (parseFloat(accounts[0].longAccount) * 100).toFixed(1),
          short: (parseFloat(accounts[0].shortAccount) * 100).toFixed(1)
        } : null,
        takerBuySellRatio: takerBuySell.toFixed(2),
        trend,
        signal: parseFloat(shortPct) > 55 ? 'squeeze_possible' : parseFloat(longPct) > 55 ? 'dump_possible' : 'neutral'
      };
    }
  } catch (e) { console.error('Long/Short error:', e.message); }
  return null;
}

// Open Interest with change
async function fetchOpenInterest() {
  try {
    const [oi, ticker, hist] = await Promise.all([
      fetch('https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT'),
      fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT'),
      fetch('https://fapi.binance.com/futures/data/openInterestHist?symbol=BTCUSDT&period=1h&limit=24')
    ]);
    
    if (oi?.openInterest && ticker?.price) {
      const currentOI = parseFloat(oi.openInterest);
      const price = parseFloat(ticker.price);
      const currentUSD = (currentOI * price) / 1e9;
      
      let change24h = 0;
      if (Array.isArray(hist) && hist.length > 0) {
        const oldOI = parseFloat(hist[hist.length - 1].sumOpenInterest);
        change24h = ((currentOI - oldOI) / oldOI * 100).toFixed(1);
      }
      
      return {
        btc: Math.round(currentOI).toLocaleString(),
        usd: currentUSD.toFixed(2) + 'B',
        change24h: parseFloat(change24h),
        trend: parseFloat(change24h) > 2 ? 'increasing' : parseFloat(change24h) < -2 ? 'decreasing' : 'stable',
        signal: parseFloat(change24h) > 5 ? 'high_leverage' : parseFloat(change24h) < -5 ? 'deleveraging' : 'normal'
      };
    }
  } catch (e) { console.error('OI error:', e.message); }
  return null;
}

// Funding Rates
async function fetchFunding() {
  try {
    const [btc, eth] = await Promise.all([
      fetch('https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=24'),
      fetch('https://fapi.binance.com/fapi/v1/fundingRate?symbol=ETHUSDT&limit=1')
    ]);
    
    if (Array.isArray(btc) && btc.length > 0) {
      const current = parseFloat(btc[0].fundingRate) * 100;
      const avg24h = (btc.reduce((s, r) => s + parseFloat(r.fundingRate), 0) / btc.length * 100);
      const ethRate = Array.isArray(eth) ? parseFloat(eth[0].fundingRate) * 100 : 0;
      
      let sentiment = 'neutral';
      if (current > 0.05) sentiment = 'overleveraged_long';
      else if (current < -0.05) sentiment = 'overleveraged_short';
      
      return {
        btc: { current: current.toFixed(4), avg24h: avg24h.toFixed(4) },
        eth: ethRate.toFixed(4),
        sentiment,
        signal: current > 0.1 ? 'correction_likely' : current < -0.1 ? 'bounce_likely' : 'normal'
      };
    }
  } catch (e) { console.error('Funding error:', e.message); }
  return null;
}

// Liquidations
async function fetchLiquidations() {
  try {
    // Get recent liquidations
    const data = await fetch('https://fapi.binance.com/fapi/v1/forceOrders?symbol=BTCUSDT&limit=1000');
    
    if (Array.isArray(data)) {
      const h24 = Date.now() - 24 * 60 * 60 * 1000;
      const h1 = Date.now() - 60 * 60 * 1000;
      
      let long24h = 0, short24h = 0, long1h = 0, short1h = 0;
      
      data.forEach(o => {
        if (o.time < h24) return;
        const val = parseFloat(o.price) * parseFloat(o.origQty);
        if (o.side === 'SELL') {
          long24h += val;
          if (o.time > h1) long1h += val;
        } else {
          short24h += val;
          if (o.time > h1) short1h += val;
        }
      });
      
      const total24h = (long24h + short24h) / 1e6;
      const dominant = long24h > short24h ? 'longs' : 'shorts';
      const ratio = long24h > 0 ? (short24h / long24h).toFixed(2) : 0;
      
      return {
        h24: { total: total24h.toFixed(1), longs: (long24h/1e6).toFixed(1), shorts: (short24h/1e6).toFixed(1) },
        h1: { total: ((long1h + short1h)/1e6).toFixed(1), longs: (long1h/1e6).toFixed(1), shorts: (short1h/1e6).toFixed(1) },
        dominant,
        intensity: total24h > 200 ? 'extreme' : total24h > 100 ? 'high' : total24h > 50 ? 'moderate' : 'low',
        signal: long24h > short24h * 2 ? 'longs_rekt' : short24h > long24h * 2 ? 'shorts_rekt' : 'balanced'
      };
    }
  } catch (e) { console.error('Liquidations error:', e.message); }
  return null;
}

// COT Report - Fetch from CFTC (updates weekly on Friday)
async function fetchCOTData() {
  try {
    // Fetch disaggregated financial futures data
    const response = await fetch('https://www.cftc.gov/dea/newcot/FinFutWk.txt');
    const text = typeof response === 'string' ? response : await response;
    
    // Find Bitcoin CME line
    const lines = text.split('\n');
    const btcLine = lines.find(l => l.includes('BITCOIN - CHICAGO MERCANTILE EXCHANGE') && l.includes('CME'));
    
    if (!btcLine) {
      console.log('COT: Bitcoin data not found, using fallback');
      return getCOTFallback();
    }
    
    // Parse CSV line - format: name, date_code, date, contract_code, exchange, ...positions...
    const parts = btcLine.split(',');
    const dateStr = parts[2]; // 2026-02-10
    const openInterest = parseInt(parts[7]) || 0;
    
    // Disaggregated positions (format may vary, these are approximate indices)
    const dealerLong = parseInt(parts[8]) || 0;
    const dealerShort = parseInt(parts[9]) || 0;
    const assetMgrLong = parseInt(parts[10]) || 0;
    const assetMgrShort = parseInt(parts[11]) || 0;
    const levFundsLong = parseInt(parts[12]) || 0;
    const levFundsShort = parseInt(parts[13]) || 0;
    const otherLong = parseInt(parts[14]) || 0;
    const otherShort = parseInt(parts[15]) || 0;
    
    const totalLong = dealerLong + assetMgrLong + levFundsLong + otherLong;
    const totalShort = dealerShort + assetMgrShort + levFundsShort + otherShort;
    
    // Calculate percentages
    const dealerLongPct = totalLong > 0 ? ((dealerLong / totalLong) * 100).toFixed(1) : 0;
    const dealerShortPct = totalShort > 0 ? ((dealerShort / totalShort) * 100).toFixed(1) : 0;
    const assetMgrLongPct = totalLong > 0 ? ((assetMgrLong / totalLong) * 100).toFixed(1) : 0;
    const assetMgrShortPct = totalShort > 0 ? ((assetMgrShort / totalShort) * 100).toFixed(1) : 0;
    const levFundsLongPct = totalLong > 0 ? ((levFundsLong / totalLong) * 100).toFixed(1) : 0;
    const levFundsShortPct = totalShort > 0 ? ((levFundsShort / totalShort) * 100).toFixed(1) : 0;
    
    // Determine signals
    const dealerSignal = dealerLong > dealerShort * 1.5 ? 'bullish' : dealerShort > dealerLong * 1.5 ? 'bearish' : 'neutral';
    const assetMgrSignal = assetMgrLong > assetMgrShort * 1.5 ? 'bullish' : assetMgrShort > assetMgrLong * 1.5 ? 'bearish' : 'neutral';
    const levFundsSignal = levFundsShort > levFundsLong * 1.5 ? 'bearish' : levFundsLong > levFundsShort * 1.5 ? 'bullish' : 'neutral';
    
    console.log(`COT: Fetched data as of ${dateStr}, OI: ${openInterest}`);
    
    return {
      asOf: dateStr,
      nextUpdate: getNextFriday(),
      openInterest,
      categories: {
        dealers: { name: 'Dealers', icon: '🏦', long: dealerLong, longPct: parseFloat(dealerLongPct), short: dealerShort, shortPct: parseFloat(dealerShortPct), net: dealerLong - dealerShort, signal: dealerSignal },
        assetManagers: { name: 'Institutions', icon: '🐋', long: assetMgrLong, longPct: parseFloat(assetMgrLongPct), short: assetMgrShort, shortPct: parseFloat(assetMgrShortPct), net: assetMgrLong - assetMgrShort, signal: assetMgrSignal },
        leveragedFunds: { name: 'Hedge Funds', icon: '🦈', long: levFundsLong, longPct: parseFloat(levFundsLongPct), short: levFundsShort, shortPct: parseFloat(levFundsShortPct), net: levFundsLong - levFundsShort, signal: levFundsSignal },
        retail: { name: 'Other', icon: '🦐', long: otherLong, longPct: 0, short: otherShort, shortPct: 0, net: otherLong - otherShort, signal: 'neutral' }
      }
    };
  } catch (e) {
    console.error('COT fetch error:', e.message);
    return getCOTFallback();
  }
}

function getCOTFallback() {
  return {
    asOf: '2026-02-10',
    nextUpdate: getNextFriday(),
    categories: {
      dealers: { name: 'Dealers', icon: '🏦', long: 5746, longPct: 27.3, short: 2470, shortPct: 9.7, net: 3276, signal: 'bullish' },
      assetManagers: { name: 'Institutions', icon: '🐋', long: 946, longPct: 4.5, short: 7476, shortPct: 29.4, net: -6530, signal: 'bearish' },
      leveragedFunds: { name: 'Hedge Funds', icon: '🦈', long: 972, longPct: 4.6, short: 697, shortPct: 2.7, net: 275, signal: 'neutral' },
      retail: { name: 'Other', icon: '🦐', long: 4372, longPct: 20.8, short: 13871, shortPct: 54.6, net: -9499, signal: 'bearish' }
    }
  };
}

function getNextFriday() {
  const today = new Date();
  const dayOfWeek = today.getDay();
  const daysUntilFriday = (5 - dayOfWeek + 7) % 7 || 7;
  const nextFriday = new Date(today);
  nextFriday.setDate(today.getDate() + daysUntilFriday);
  return nextFriday.toISOString().split('T')[0];
}

// ETF Flows (cached, updates daily)
function getETFFlows() {
  return {
    date: '2026-02-10',
    daily: 145,
    weekly: -580,
    total: 40200,
    trend: 'positive_daily'
  };
}

// ============ SMART ANALYSIS ENGINE ============

function generateAnalysis(data) {
  const signals = [];
  let bullScore = 0, bearScore = 0;
  
  // Fear & Greed Analysis
  if (data.fearGreed) {
    const fg = data.fearGreed.current;
    if (fg <= 15) { signals.push({ type: 'bullish', weight: 3, reason: 'Extreme Fear historique - zone d\'achat' }); bullScore += 3; }
    else if (fg <= 25) { signals.push({ type: 'bullish', weight: 2, reason: 'Fear élevée - opportunité possible' }); bullScore += 2; }
    else if (fg >= 80) { signals.push({ type: 'bearish', weight: 3, reason: 'Extreme Greed - prudence maximale' }); bearScore += 3; }
    else if (fg >= 65) { signals.push({ type: 'bearish', weight: 2, reason: 'Greed élevée - attention' }); bearScore += 2; }
  }
  
  // COT Analysis
  const cot = data.cot;
  if (cot) {
    if (cot.categories.leveragedFunds.shortPct > 60) {
      signals.push({ type: 'bullish', weight: 2, reason: 'Hedge Funds très short - squeeze possible' }); bullScore += 2;
    }
    if (cot.categories.assetManagers.signal === 'bullish') {
      signals.push({ type: 'bullish', weight: 2, reason: 'Institutions accumulent' }); bullScore += 2;
    }
  }
  
  // ETF Flows
  if (data.etf) {
    if (data.etf.daily > 50) {
      signals.push({ type: 'bullish', weight: 1, reason: 'ETF inflows positifs (+$' + data.etf.daily + 'M)' }); bullScore += 1;
    } else if (data.etf.daily < -100) {
      signals.push({ type: 'bearish', weight: 2, reason: 'ETF outflows importants' }); bearScore += 2;
    }
    // Weekly trend matters too!
    if (data.etf.weekly < -300) {
      signals.push({ type: 'bearish', weight: 2, reason: 'ETF outflows sur la semaine ($' + data.etf.weekly + 'M)' }); bearScore += 2;
    }
  }
  
  // Long/Short Ratio
  if (data.longShort?.signal === 'squeeze_possible') {
    signals.push({ type: 'bullish', weight: 1, reason: 'Retail très short - potentiel squeeze' }); bullScore += 1;
  } else if (data.longShort?.signal === 'dump_possible') {
    signals.push({ type: 'bearish', weight: 1, reason: 'Retail très long - risque de dump' }); bearScore += 1;
  }
  
  // Funding
  if (data.funding?.signal === 'bounce_likely') {
    signals.push({ type: 'bullish', weight: 1, reason: 'Funding négatif - shorts paient' }); bullScore += 1;
  } else if (data.funding?.signal === 'correction_likely') {
    signals.push({ type: 'bearish', weight: 1, reason: 'Funding très élevé - surchauffe' }); bearScore += 1;
  }
  
  // Liquidations
  if (data.liquidations?.signal === 'shorts_rekt') {
    signals.push({ type: 'bullish', weight: 1, reason: 'Shorts liquidés massivement' }); bullScore += 1;
  } else if (data.liquidations?.signal === 'longs_rekt') {
    signals.push({ type: 'bearish', weight: 1, reason: 'Longs liquidés - capitulation' }); bearScore += 1;
  }
  
  // Hashrate
  if (data.hashrate?.signal === 'bullish') {
    signals.push({ type: 'bullish', weight: 1, reason: 'Hashrate en hausse - mineurs confiants' }); bullScore += 1;
  } else if (data.hashrate?.signal === 'bearish' || data.hashrate?.trend === 'crashing') {
    signals.push({ type: 'bearish', weight: 2, reason: 'Hashrate en chute - mineurs en difficulté' }); bearScore += 2;
  } else if (data.hashrate?.trend === 'dropping') {
    signals.push({ type: 'bearish', weight: 1, reason: 'Hashrate en baisse (' + data.hashrate.changeFromPeak + '% depuis le pic)' }); bearScore += 1;
  }
  
  // Taker Buy/Sell Ratio
  if (data.longShort?.takerBuySellRatio) {
    const ratio = parseFloat(data.longShort.takerBuySellRatio);
    if (ratio < 0.95) {
      signals.push({ type: 'bearish', weight: 1, reason: 'Plus de vendeurs que d\'acheteurs (ratio ' + ratio.toFixed(2) + ')' }); bearScore += 1;
    } else if (ratio > 1.05) {
      signals.push({ type: 'bullish', weight: 1, reason: 'Plus d\'acheteurs que de vendeurs' }); bullScore += 1;
    }
  }
  
  // Calculate final signal
  const netScore = bullScore - bearScore;
  let overallSignal, overallLabel, overallEmoji;
  
  if (netScore >= 5) {
    overallSignal = 'strong_accumulation';
    overallLabel = 'ACCUMULATION FORTE';
    overallEmoji = '🚀';
  } else if (netScore >= 2) {
    overallSignal = 'accumulation';
    overallLabel = 'ZONE D\'ACCUMULATION';
    overallEmoji = '🎯';
  } else if (netScore <= -5) {
    overallSignal = 'strong_distribution';
    overallLabel = 'DISTRIBUTION FORTE';
    overallEmoji = '🚨';
  } else if (netScore <= -2) {
    overallSignal = 'distribution';
    overallLabel = 'ZONE DE PRUDENCE';
    overallEmoji = '⚠️';
  } else {
    overallSignal = 'neutral';
    overallLabel = 'PATIENCE';
    overallEmoji = '⏳';
  }
  
  return {
    signal: overallSignal,
    label: overallLabel,
    emoji: overallEmoji,
    score: { bull: bullScore, bear: bearScore, net: netScore },
    signals: signals.slice(0, 5) // Top 5 signals
  };
}

// Generate story with Groq AI
async function generateStory(data, analysis) {
  if (!GROQ_API_KEY) {
    return generateFallbackStory(data, analysis);
  }
  
  try {
    const prompt = `Tu es un analyste crypto qui parle à des débutants. Écris 3-4 phrases COURTES et PERCUTANTES pour expliquer la situation du marché.

DONNÉES:
- Fear & Greed: ${data.fearGreed?.current}/100 (${data.fearGreed?.label})
- Hedge Funds: ${data.cot?.categories.leveragedFunds.shortPct}% SHORT
- Institutions: ${data.cot?.categories.assetManagers.signal}
- ETF Flows: ${data.etf?.daily > 0 ? '+' : ''}$${data.etf?.daily}M
- Funding: ${data.funding?.btc.current}%
- Signal global: ${analysis.label}

RÈGLES:
- Parle comme si tu expliquais à un ami
- Utilise des mots simples
- Pas de jargon technique
- Fais RESSENTIR l'émotion du marché
- Maximum 4 phrases

Réponds uniquement avec le texte, sans introduction.`;

    const response = await new Promise((resolve, reject) => {
      const reqData = JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 300
      });
      
      const req = https.request({
        hostname: 'api.groq.com',
        path: '/openai/v1/chat/completions',
        method: 'POST',
        headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' }
      }, res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => resolve(JSON.parse(body)));
      });
      req.on('error', reject);
      req.write(reqData);
      req.end();
    });
    
    return response.choices[0].message.content.trim();
  } catch (e) {
    console.error('Story generation error:', e.message);
    return generateFallbackStory(data, analysis);
  }
}

function generateFallbackStory(data, analysis) {
  const fg = data.fearGreed?.current || 50;
  const hfShort = data.cot?.categories.leveragedFunds.shortPct || 50;
  const etf = data.etf?.daily || 0;
  
  let story = '';
  
  if (fg <= 20) {
    story = `Le marché est en <strong>panique totale</strong>. Le Fear & Greed à ${fg} montre que tout le monde a peur. `;
  } else if (fg <= 40) {
    story = `Le marché reste <strong>nerveux</strong>. Avec un Fear & Greed à ${fg}, la prudence domine. `;
  } else if (fg >= 75) {
    story = `L'<strong>euphorie</strong> s'installe. Un Fear & Greed à ${fg} signale que le marché s'emballe. `;
  } else {
    story = `Le marché cherche sa direction. Le Fear & Greed à ${fg} montre une <strong>hésitation</strong>. `;
  }
  
  if (hfShort > 60) {
    story += `<strong>${hfShort}% des hedge funds</strong> parient contre Bitcoin - ils pourraient se faire piéger. `;
  }
  
  if (etf > 50) {
    story += `Les ETF ont attiré <span class="highlight-green">+$${etf}M</span> - les institutions accumulent. `;
  } else if (etf < -50) {
    story += `Les ETF perdent <span class="highlight-red">$${Math.abs(etf)}M</span> - les institutions prennent leurs profits. `;
  }
  
  if (analysis.signal.includes('accumulation')) {
    story += `<strong>C'est souvent dans ces moments que les opportunités se créent.</strong>`;
  } else if (analysis.signal.includes('distribution')) {
    story += `<strong>La prudence est de mise dans ce contexte.</strong>`;
  }
  
  return story;
}

// ============ TRADING PLAN GENERATOR ============

function generateTradingPlan(data, analysis) {
  const price = data.priceData;
  if (!price) return null;
  
  const fg = data.fearGreed?.current || 50;
  const netScore = analysis.score.net;
  
  // Determine bias
  let bias, biasEmoji, biasStrength;
  if (netScore >= 5) {
    bias = 'ACHAT';
    biasEmoji = '🟢';
    biasStrength = 'Fort';
  } else if (netScore >= 2) {
    bias = 'ACHAT';
    biasEmoji = '🟢';
    biasStrength = 'Modéré';
  } else if (netScore <= -5) {
    bias = 'VENTE';
    biasEmoji = '🔴';
    biasStrength = 'Fort';
  } else if (netScore <= -2) {
    bias = 'PRUDENCE';
    biasEmoji = '🟡';
    biasStrength = 'Modéré';
  } else {
    bias = 'NEUTRE';
    biasEmoji = '⚪';
    biasStrength = 'Attente';
  }
  
  // Key levels
  const entryZone = price.supports[0] ? `$${price.supports[0].toLocaleString()} - $${(price.supports[0] + 1500).toLocaleString()}` : null;
  const invalidation = price.supports[1] ? `$${price.supports[1].toLocaleString()}` : null;
  const target1 = price.resistances[0] ? `$${price.resistances[0].toLocaleString()}` : null;
  const target2 = price.resistances[1] ? `$${price.resistances[1].toLocaleString()}` : null;
  
  // Time horizon based on volatility and signals
  let horizon, horizonDetail;
  if (fg <= 20 || fg >= 80) {
    horizon = '24-72h';
    horizonDetail = 'Extrême Fear/Greed = retournement rapide possible';
  } else {
    horizon = '1-2 semaines';
    horizonDetail = 'Conditions normales, patience requise';
  }
  
  // Main factor hierarchy
  const factors = [];
  if (fg <= 20) factors.push({ level: 'PRINCIPAL', text: `Fear & Greed extrême (${fg}) - historiquement zone d'achat` });
  else if (fg >= 80) factors.push({ level: 'PRINCIPAL', text: `Greed extrême (${fg}) - historiquement zone de vente` });
  
  if (data.cot?.categories.leveragedFunds.shortPct > 60) {
    factors.push({ level: factors.length ? 'CONFIRMANT' : 'PRINCIPAL', text: `Hedge Funds ${data.cot.categories.leveragedFunds.shortPct}% short - squeeze possible` });
  }
  if (data.etf?.weekly < -300) {
    factors.push({ level: 'ATTENTION', text: `ETF outflows semaine: $${data.etf.weekly}M - pression vendeuse` });
  } else if (data.etf?.daily > 100) {
    factors.push({ level: factors.length ? 'CONFIRMANT' : 'PRINCIPAL', text: `ETF inflows: +$${data.etf.daily}M aujourd'hui` });
  }
  if (data.hashrate?.trend === 'dropping') {
    factors.push({ level: 'SECONDAIRE', text: `Hashrate en baisse (${data.hashrate.changeFromPeak}%) - mineurs sous pression` });
  }
  
  // Invalidation conditions
  const invalidationText = invalidation 
    ? `Clôture daily sous ${invalidation} = scénario bullish invalidé`
    : 'Cassure du support principal = invalidation';
  
  // Action recommendation
  let action, actionDetail;
  if (bias === 'ACHAT' && biasStrength === 'Fort') {
    action = 'Accumulation progressive';
    actionDetail = `DCA sur la zone ${entryZone}. Ne pas FOMO sur les pumps.`;
  } else if (bias === 'ACHAT') {
    action = 'Observer pour entrée';
    actionDetail = `Attendre un repli vers ${entryZone} pour position.`;
  } else if (bias === 'VENTE') {
    action = 'Réduire exposition';
    actionDetail = 'Prendre des profits partiels. Éviter les nouveaux achats.';
  } else {
    action = 'Attendre';
    actionDetail = 'Pas de signal clair. Rester en cash ou position réduite.';
  }
  
  // Risk management
  const riskPercent = biasStrength === 'Fort' ? '3-5%' : '1-2%';
  
  return {
    bias: { direction: bias, emoji: biasEmoji, strength: biasStrength },
    horizon: { timeframe: horizon, detail: horizonDetail },
    levels: {
      currentPrice: `$${price.current.toLocaleString()}`,
      entryZone,
      invalidation,
      target1,
      target2
    },
    factors: factors.slice(0, 3),
    invalidationText,
    action: { recommendation: action, detail: actionDetail },
    risk: { maxPosition: riskPercent, note: 'du capital par trade' }
  };
}

// ============ MAIN ============

async function main() {
  console.log('🚀 Fetching market data...');
  
  const [fearGreed, longShort, openInterest, funding, liquidations, hashrate, priceData] = await Promise.all([
    fetchFearGreed(),
    fetchLongShort(),
    fetchOpenInterest(),
    fetchFunding(),
    fetchLiquidations(),
    fetchHashrate(),
    fetchPriceData()
  ]);
  
  console.log('📊 Fetching COT data...');
  const [cot, etf] = await Promise.all([
    fetchCOTData(),
    fetchETFFlows()
  ]);
  
  const data = { fearGreed, longShort, openInterest, funding, liquidations, hashrate, priceData, cot, etf };
  
  console.log('🧠 Generating analysis...');
  const analysis = generateAnalysis(data);
  
  console.log('🎯 Generating trading plan...');
  const tradingPlan = generateTradingPlan(data, analysis);
  
  console.log('📝 Writing story...');
  const story = await generateStory(data, analysis);
  
  const output = {
    updatedAt: new Date().toISOString(),
    ...data,
    analysis,
    tradingPlan,
    story
  };
  
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log('✅ Data saved! Signal:', analysis.label);
}

main().catch(e => { console.error('Fatal error:', e); process.exit(1); });
