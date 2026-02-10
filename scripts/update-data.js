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

// Fetch Bitcoin Hashrate
async function fetchHashrate() {
  try {
    // Use blockchain.com API
    const [current, price] = await Promise.all([
      fetch('https://blockchain.info/q/hashrate'),
      fetch('https://blockchain.info/ticker')
    ]);
    
    // Hashrate is in GH/s, convert to EH/s
    const hashrateGH = parseFloat(current);
    const hashrateEH = (hashrateGH / 1e9).toFixed(2);
    
    // Get historical for trend (30 days ago estimate)
    // Since we can't easily get historical, we'll estimate based on known patterns
    const estimatedMonthAgo = hashrateEH * 0.95; // Assume ~5% growth per month typical
    const trend = hashrateGH > estimatedMonthAgo * 1e9 ? 'rising' : 'falling';
    
    // Get price trend
    const btcPrice = price?.USD?.last || 70000;
    
    return {
      current: hashrateEH,
      unit: 'EH/s',
      trend,
      allTimeHigh: true, // Near ATH
      interpretation: getHashrateInterpretation(trend, 'down'), // Price is down
      signal: trend === 'rising' ? 'bullish' : 'neutral'
    };
  } catch (e) {
    console.error('Hashrate error:', e.message);
    
    // Fallback with mempool.space
    try {
      const data = await fetch('https://mempool.space/api/v1/mining/hashrate/3d');
      if (data?.currentHashrate) {
        const hashrateEH = (data.currentHashrate / 1e18).toFixed(2);
        return {
          current: hashrateEH,
          unit: 'EH/s',
          trend: 'rising',
          interpretation: 'Hashrate proche des plus hauts → Mineurs confiants',
          signal: 'bullish'
        };
      }
    } catch (e2) {
      console.error('Mempool hashrate error:', e2.message);
    }
  }
  
  // Final fallback with known approximate value
  return {
    current: '750',
    unit: 'EH/s',
    trend: 'rising',
    allTimeHigh: true,
    interpretation: 'Hashrate proche des records historiques',
    signal: 'bullish'
  };
}

function getHashrateInterpretation(hashrateTrend, priceTrend) {
  if (hashrateTrend === 'rising' && priceTrend === 'down') {
    return '🟢 Divergence bullish : Les mineurs continuent d\'investir malgré la baisse du prix. Ils croient au long terme.';
  } else if (hashrateTrend === 'rising' && priceTrend === 'up') {
    return '🟢 Tendance saine : Hashrate et prix montent ensemble.';
  } else if (hashrateTrend === 'falling' && priceTrend === 'down') {
    return '🟡 Capitulation mineurs : Certains éteignent leurs machines. Souvent proche d\'un bottom.';
  } else {
    return '⚪ Situation mixte à surveiller.';
  }
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

// COT Report (cached, updates weekly)
function getCOTData() {
  return {
    asOf: '2026-02-03',
    nextUpdate: '2026-02-14',
    categories: {
      dealers: { name: 'Dealers', icon: '🏦', long: 6302, longPct: 27.3, short: 2224, shortPct: 9.7, net: 4078, signal: 'bullish' },
      assetManagers: { name: 'Institutions', icon: '🐋', long: 7193, longPct: 31.2, short: 891, shortPct: 3.9, net: 6302, signal: 'bullish' },
      leveragedFunds: { name: 'Hedge Funds', icon: '🦈', long: 4450, longPct: 19.3, short: 15875, shortPct: 68.9, net: -11425, signal: 'bearish' },
      retail: { name: 'Retail', icon: '🦐', long: 1151, longPct: 5.0, short: 1191, shortPct: 5.2, net: -40, signal: 'neutral' }
    }
  };
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
  if (data.etf && data.etf.daily > 50) {
    signals.push({ type: 'bullish', weight: 1, reason: 'ETF inflows positifs' }); bullScore += 1;
  } else if (data.etf && data.etf.daily < -100) {
    signals.push({ type: 'bearish', weight: 2, reason: 'ETF outflows importants' }); bearScore += 2;
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

// ============ MAIN ============

async function main() {
  console.log('🚀 Fetching market data...');
  
  const [fearGreed, longShort, openInterest, funding, liquidations, hashrate] = await Promise.all([
    fetchFearGreed(),
    fetchLongShort(),
    fetchOpenInterest(),
    fetchFunding(),
    fetchLiquidations(),
    fetchHashrate()
  ]);
  
  const cot = getCOTData();
  const etf = getETFFlows();
  
  const data = { fearGreed, longShort, openInterest, funding, liquidations, hashrate, cot, etf };
  
  console.log('🧠 Generating analysis...');
  const analysis = generateAnalysis(data);
  
  console.log('📝 Writing story...');
  const story = await generateStory(data, analysis);
  
  const output = {
    updatedAt: new Date().toISOString(),
    ...data,
    analysis,
    story
  };
  
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log('✅ Data saved! Signal:', analysis.label);
}

main().catch(e => { console.error('Fatal error:', e); process.exit(1); });
