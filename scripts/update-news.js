#!/usr/bin/env node
/**
 * MAMOS DASHBOARD - Smart News Engine
 * Fetches news + analyzes with market context + explains price impact
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const OUTPUT_PATH = path.join(__dirname, '..', 'news.json');
const DATA_PATH = path.join(__dirname, '..', 'data.json');

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'MamosDashboard/2.0' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function parseRSS(xml) {
  const items = [];
  const regex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  
  while ((match = regex.exec(xml)) !== null) {
    const item = match[1];
    const title = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] 
                  || item.match(/<title>(.*?)<\/title>/)?.[1] || '';
    const link = item.match(/<link>(.*?)<\/link>/)?.[1] || '';
    const pubDate = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';
    const desc = item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/)?.[1]
                 || item.match(/<description>(.*?)<\/description>/)?.[1] || '';
    
    if (title) items.push({ 
      title: title.trim(), 
      link: link.replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim(),
      date: pubDate,
      description: desc.replace(/<[^>]*>/g, '').slice(0, 500)
    });
  }
  return items;
}

// Get current market context
function getMarketContext() {
  try {
    if (fs.existsSync(DATA_PATH)) {
      const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
      return {
        fearGreed: data.fearGreed?.current,
        fearGreedLabel: data.fearGreed?.label,
        hedgeFundsShort: data.cot?.categories?.leveragedFunds?.shortPct,
        institutionsSignal: data.cot?.categories?.assetManagers?.signal,
        etfFlow: data.etf?.daily,
        fundingRate: data.funding?.btc?.current,
        signal: data.analysis?.label
      };
    }
  } catch (e) {}
  return null;
}

// Analyze news with AI + market context
async function analyzeNews(newsItems, context) {
  if (!GROQ_API_KEY) {
    return newsItems.map(n => ({
      ...n,
      titleFr: n.title,
      summary: n.description.slice(0, 150),
      impact: 'neutre',
      priceEffect: 'Impact incertain',
      importance: 3
    }));
  }
  
  const contextStr = context ? `
CONTEXTE MARCHÉ ACTUEL:
- Fear & Greed: ${context.fearGreed}/100 (${context.fearGreedLabel})
- Hedge Funds: ${context.hedgeFundsShort}% SHORT
- Institutions: ${context.institutionsSignal}
- ETF Flows 24h: ${context.etfFlow > 0 ? '+' : ''}$${context.etfFlow}M
- Funding Rate: ${context.fundingRate}%
- Signal global: ${context.signal}
` : '';

  const prompt = `Tu es un analyste crypto expert. Analyse ces news EN CONTEXTE du marché actuel.
${contextStr}

NEWS À ANALYSER:
${newsItems.map((n, i) => `${i+1}. ${n.title}\n   ${n.description.slice(0, 200)}`).join('\n\n')}

Pour CHAQUE news, donne:
1. titleFr: Titre traduit en français (accrocheur, max 60 chars)
2. summary: Résumé en 1 phrase simple (pour débutant)
3. impact: "bullish", "bearish", ou "neutre"
4. priceEffect: Explication de l'impact potentiel sur le prix (1-2 phrases, en contexte du marché actuel)
5. importance: Note de 1-5 (5 = très important pour un trader)
6. contextLink: Comment cette news se connecte au contexte actuel (1 phrase)

IMPORTANT: Prends en compte le contexte marché ! Une news bullish dans un marché en fear extrême = potentiel rebond. Une news bearish quand tout le monde est short = peut-être déjà pricé.

Réponds en JSON valide uniquement:
[{"index": 1, "titleFr": "...", "summary": "...", "impact": "...", "priceEffect": "...", "importance": 5, "contextLink": "..."}, ...]`;

  try {
    const response = await new Promise((resolve, reject) => {
      const data = JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.4,
        max_tokens: 2500
      });
      
      const req = https.request({
        hostname: 'api.groq.com',
        path: '/openai/v1/chat/completions',
        method: 'POST',
        headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' }
      }, res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch { reject(new Error('Invalid JSON')); }
        });
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
    
    const content = response.choices?.[0]?.message?.content || '';
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const analysis = JSON.parse(jsonMatch[0]);
      return newsItems.map((n, i) => {
        const a = analysis.find(x => x.index === i + 1) || {};
        return {
          ...n,
          titleFr: a.titleFr || n.title,
          summary: a.summary || n.description.slice(0, 150),
          impact: a.impact || 'neutre',
          priceEffect: a.priceEffect || '',
          importance: a.importance || 3,
          contextLink: a.contextLink || ''
        };
      });
    }
  } catch (e) {
    console.error('AI analysis error:', e.message);
  }
  
  return newsItems.map(n => ({
    ...n,
    titleFr: n.title,
    summary: n.description.slice(0, 150),
    impact: 'neutre',
    priceEffect: '',
    importance: 3
  }));
}

// Generate market narrative combining news + data
async function generateNarrative(news, context) {
  if (!GROQ_API_KEY || !context) return null;
  
  const topNews = news.filter(n => n.importance >= 4).slice(0, 3);
  if (topNews.length === 0) return null;
  
  const prompt = `Tu es un analyste crypto qui parle à des débutants.

CONTEXTE MARCHÉ:
- Fear & Greed: ${context.fearGreed}/100 (${context.fearGreedLabel})
- Hedge Funds: ${context.hedgeFundsShort}% SHORT sur Bitcoin
- ETF Flows: ${context.etfFlow > 0 ? '+' : ''}$${context.etfFlow}M
- Signal Smart Money: ${context.signal}

NEWS IMPORTANTES DU JOUR:
${topNews.map(n => `- ${n.titleFr}: ${n.summary}`).join('\n')}

Écris un PARAGRAPHE (4-5 phrases) qui:
1. Relie les news au contexte du marché
2. Explique ce que ça signifie pour le prix
3. Donne une perspective actionnable (attendre, accumuler, prudence)
4. Utilise un ton accessible, pas de jargon

Réponds uniquement avec le paragraphe, sans introduction.`;

  try {
    const response = await new Promise((resolve, reject) => {
      const data = JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 400
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
      req.write(data);
      req.end();
    });
    
    return response.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    console.error('Narrative error:', e.message);
    return null;
  }
}

async function main() {
  console.log('📰 Fetching news...');
  
  // Fetch from multiple sources
  const sources = [
    { name: 'CoinTelegraph', url: 'https://cointelegraph.com/rss' },
    { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' }
  ];
  
  let allNews = [];
  for (const src of sources) {
    try {
      const xml = await fetch(src.url);
      const items = parseRSS(xml).map(n => ({ ...n, source: src.name }));
      allNews = allNews.concat(items);
    } catch (e) {
      console.error(`${src.name} error:`, e.message);
    }
  }
  
  // Sort by date, take top 8
  allNews.sort((a, b) => new Date(b.date) - new Date(a.date));
  allNews = allNews.slice(0, 8);
  
  console.log(`📊 Got ${allNews.length} news, analyzing with market context...`);
  
  // Get market context
  const context = getMarketContext();
  if (context) {
    console.log(`   Context: F&G=${context.fearGreed}, HF Short=${context.hedgeFundsShort}%`);
  }
  
  // Analyze with AI
  const analyzed = await analyzeNews(allNews, context);
  
  // Filter by importance
  const important = analyzed.filter(n => n.importance >= 3).slice(0, 5);
  
  // Generate narrative
  console.log('📝 Generating market narrative...');
  const narrative = await generateNarrative(important, context);
  
  // Save output
  const output = {
    updatedAt: new Date().toISOString(),
    context: context ? {
      fearGreed: context.fearGreed,
      hedgeFundsShort: context.hedgeFundsShort,
      signal: context.signal
    } : null,
    narrative,
    news: important.map(n => ({
      title: n.titleFr,
      titleOriginal: n.title,
      summary: n.summary,
      impact: n.impact,
      priceEffect: n.priceEffect,
      contextLink: n.contextLink,
      importance: n.importance,
      source: n.source,
      link: n.link,
      date: n.date
    }))
  };
  
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log('✅ News saved with', important.length, 'articles');
  if (narrative) console.log('✅ Market narrative generated');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
