#!/usr/bin/env node
/**
 * Fetch, translate, summarize and analyze crypto news
 * Outputs to news.json for the dashboard
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
if (!GROQ_API_KEY) {
  console.error('GROQ_API_KEY not set');
  process.exit(1);
}
const OUTPUT_PATH = path.join(__dirname, '..', 'news.json');

// Fetch RSS feed
function fetchRSS(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// Parse RSS XML (simple parser)
function parseRSS(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  
  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];
    const title = itemXml.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] 
                  || itemXml.match(/<title>(.*?)<\/title>/)?.[1] || '';
    const link = itemXml.match(/<link>(.*?)<\/link>/)?.[1] || '';
    const pubDate = itemXml.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';
    const description = itemXml.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/)?.[1]
                        || itemXml.match(/<description>(.*?)<\/description>/)?.[1] || '';
    
    if (title && link) {
      items.push({ title, link, pubDate, description: description.replace(/<[^>]*>/g, '').slice(0, 300) });
    }
  }
  
  return items.slice(0, 8);
}

// Call Groq API for translation and analysis
async function analyzeNews(items) {
  const prompt = `Tu es un analyste crypto expert. Voici les dernières news crypto en anglais.

Pour chaque news:
1. Traduis le titre en français (court et accrocheur)
2. Fais une synthèse en 1 phrase
3. Évalue l'impact potentiel sur le marché: "bullish", "bearish", ou "neutre"
4. Note la pertinence de 1 à 5 (5 = très pertinent pour un trader)

News:
${items.map((item, i) => `${i+1}. ${item.title}\n   ${item.description}`).join('\n\n')}

Réponds en JSON valide uniquement, format:
[
  {
    "index": 1,
    "titleFr": "...",
    "summary": "...",
    "impact": "bullish|bearish|neutre",
    "relevance": 1-5
  }
]`;

  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 2000
    });

    const req = https.request({
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(body);
          const content = response.choices[0].message.content;
          // Extract JSON from response
          const jsonMatch = content.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            resolve(JSON.parse(jsonMatch[0]));
          } else {
            reject(new Error('No JSON in response'));
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  console.log('Fetching news...');
  
  // Fetch from multiple sources
  const sources = [
    { name: 'CoinTelegraph', url: 'https://cointelegraph.com/rss' },
    { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' }
  ];
  
  let allItems = [];
  
  for (const source of sources) {
    try {
      const xml = await fetchRSS(source.url);
      const items = parseRSS(xml).map(item => ({ ...item, source: source.name }));
      allItems = allItems.concat(items);
    } catch (e) {
      console.error(`Error fetching ${source.name}:`, e.message);
    }
  }
  
  // Sort by date and take top 6
  allItems.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  allItems = allItems.slice(0, 6);
  
  console.log(`Got ${allItems.length} news items, analyzing...`);
  
  // Analyze with AI
  try {
    const analysis = await analyzeNews(allItems);
    
    // Merge analysis with items
    const enrichedNews = allItems.map((item, i) => {
      const a = analysis.find(x => x.index === i + 1) || {};
      return {
        titleOriginal: item.title,
        title: a.titleFr || item.title,
        summary: a.summary || '',
        impact: a.impact || 'neutre',
        relevance: a.relevance || 3,
        source: item.source,
        link: item.link,
        date: item.pubDate,
        timestamp: new Date(item.pubDate).getTime()
      };
    });
    
    // Filter by relevance (keep 4+ only, or top 5)
    const filtered = enrichedNews
      .filter(n => n.relevance >= 3)
      .slice(0, 5);
    
    // Save to JSON
    const output = {
      updatedAt: new Date().toISOString(),
      news: filtered
    };
    
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
    console.log(`Saved ${filtered.length} news items to ${OUTPUT_PATH}`);
    
  } catch (e) {
    console.error('Analysis error:', e.message);
    
    // Fallback: save raw news without analysis
    const output = {
      updatedAt: new Date().toISOString(),
      news: allItems.slice(0, 5).map(item => ({
        title: item.title,
        summary: item.description,
        impact: 'neutre',
        relevance: 3,
        source: item.source,
        link: item.link,
        date: item.pubDate
      }))
    };
    
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
    console.log('Saved fallback news (no AI analysis)');
  }
}

main().catch(console.error);
