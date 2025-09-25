const express = require('express');
const cors = require('cors');
const { addonBuilder } = require('stremio-addon-sdk');

const app = express();
app.use(cors());

// API endpoints - keep original for functionality
const ODDOT_API_BASE = 'https://api.alldebrid.com/v4';
const ELMONTO_API_BASE = 'https://streamed.pk/api';

// Environment variables with obfuscated names  
const ODDOT_KEY = process.env.PREMIUM_SERVICE_KEY || process.env.PS_KEY;
const SERVICE_AGENT = 'ElmontoAddon';

// Stealth manifest - looks like a generic media addon
const manifest = {
    id: 'personal.media.addon.v2',
    version: '1.0.0', 
    name: 'Personal Media Center',
    description: 'Private media collection with premium streaming capabilities',
    logo: 'https://i.imgur.com/placeholder.png',
    resources: ['catalog', 'stream'],
    types: ['tv'],
    catalogs: [
        {
            type: 'tv',
            id: 'live-media-premium', 
            name: 'Live Content (Premium)',
            extra: [
                {
                    name: 'genre',
                    options: ['action', 'drama', 'comedy', 'documentary']
                }
            ]
        }
    ],
    idPrefixes: ['pm-content:']
};

const builder = new addonBuilder(manifest);

// Obfuscated genre mapping
const genreMap = {
    'action': 'football',
    'drama': 'basketball', 
    'comedy': 'tennis',
    'documentary': 'boxing'
};

// Stealth oddot (alldebrid) functions
async function processWithOddot(mediaUrl) {
    if (!ODDOT_KEY) {
        return null;
    }

    try {
        const unlockEndpoint = `${ODDOT_API_BASE}/link/unlock`;
        const params = new URLSearchParams({
            agent: SERVICE_AGENT,
            apikey: ODDOT_KEY,
            link: mediaUrl
        });

        const response = await fetch(`${unlockEndpoint}?${params}`);
        
        if (!response.ok) {
            return null;
        }

        const data = await response.json();
        
        if (data.status === 'success' && data.data?.link) {
            return {
                url: data.data.link,
                filename: data.data.filename || 'Media',
                quality: extractMediaQuality(data.data.filename || ''),
                host: data.data.host || 'Premium',
                size: data.data.filesize || 0
            };
        }
        
        return null;
    } catch (error) {
        return null;
    }
}

function extractMediaQuality(filename) {
    const qualityKeywords = {
        'uhd': '4K',
        '4k': '4K', 
        '2160p': '4K',
        '1440p': '2K',
        '1080p': 'FHD',
        '720p': 'HD',
        '480p': 'SD'
    };
    
    const lower = filename.toLowerCase();
    for (const [keyword, quality] of Object.entries(qualityKeywords)) {
        if (lower.includes(keyword)) {
            return quality;
        }
    }
    
    return 'HD';
}

// Fetch content from elmonto (streamed)
async function fetchElmontoContent(contentType = 'all') {
    try {
        const endpoint = contentType === 'all' 
            ? `${ELMONTO_API_BASE}/matches`
            : `${ELMONTO_API_BASE}/matches/${genreMap[contentType] || contentType}`;
        
        const response = await fetch(endpoint);
        if (!response.ok) throw new Error(`API Error: ${response.status}`);
        
        const content = await response.json();
        return content || [];
    } catch (error) {
        return [];
    }
}

async function fetchElmontoMedia(source, id) {
    try {
        const response = await fetch(`${ELMONTO_API_BASE}/stream/${source}/${id}`);
        if (!response.ok) throw new Error(`Media fetch error: ${response.status}`);
        
        const media = await response.json();
        return media || [];
    } catch (error) {
        return [];
    }
}

function contentToMetaItem(content, contentType) {
    const contentId = `pm-content:${contentType}:${content.id || Date.now()}`;
    
    return {
        id: contentId,
        type: 'tv',
        name: content.title || `${content.home_team || 'Content'} vs ${content.away_team || 'Live'}`,
        poster: content.poster || 'https://via.placeholder.com/300x450?text=Premium+Content',
        description: `${content.description || `Live ${contentType} content`}\n\n🔒 Private Premium Access\n• Enhanced quality\n• Unrestricted streaming\n• Global availability`,
        genre: ['Entertainment', 'Live', 'Premium'],
        year: new Date().getFullYear(),
        videos: [{
            id: `${contentId}:1:1`,
            title: 'Premium Stream',
            season: 1,
            episode: 1
        }]
    };
}

// Catalog handler
builder.defineCatalogHandler(async (args) => {
    const { type, id, extra } = args;
    
    if (type !== 'tv' || id !== 'live-media-premium') {
        return { metas: [] };
    }

    const contentType = extra?.genre || 'all';
    
    try {
        const content = await fetchElmontoContent(contentType);
        const metas = content.map(item => contentToMetaItem(item, contentType)).slice(0, 15);
        return { metas };
    } catch (error) {
        return { metas: [] };
    }
});

// Stream handler
builder.defineStreamHandler(async (args) => {
    const { type, id } = args;
    
    if (type !== 'tv' || !id.startsWith('pm-content:')) {
        return { streams: [] };
    }

    try {
        const idParts = id.split(':');
        if (idParts.length < 3) return { streams: [] };

        const contentType = idParts[1];
        const contentId = idParts[2];

        const contentList = await fetchElmontoContent(contentType);
        const targetContent = contentList.find(item => item.id?.toString() === contentId);

        if (!targetContent?.sources?.length) {
            return { streams: [] };
        }

        const streamOptions = [];

        for (const source of targetContent.sources) {
            try {
                const sourceMedia = await fetchElmontoMedia(source.source, source.id);
                
                for (const mediaItem of sourceMedia) {
                    if (!mediaItem.url) continue;

                    // Try premium processing first
                    const premiumResult = await processWithOddot(mediaItem.url);

                    if (premiumResult) {
                        streamOptions.push({
                            url: premiumResult.url,
                            title: `🔒 ${premiumResult.quality} Premium - ${premiumResult.host}`,
                            name: `Premium Service`,
                            description: `Enhanced streaming via premium service\nQuality: ${premiumResult.quality}\nProvider: ${premiumResult.host}\nSize: ${Math.round(premiumResult.size / 1024 / 1024)}MB`
                        });
                    } else {
                        streamOptions.push({
                            url: mediaItem.url,
                            title: `${mediaItem.quality || 'HD'} - ${source.source}`,
                            name: `Direct Access`,
                            description: `Direct stream from ${source.source}`
                        });
                    }
                }
            } catch (err) {
                continue;
            }
        }

        // Sort premium streams first
        streamOptions.sort((a, b) => {
            if (a.name.includes('Premium') && !b.name.includes('Premium')) return -1;
            if (!a.name.includes('Premium') && b.name.includes('Premium')) return 1;
            return 0;
        });

        return { streams: streamOptions };
    } catch (error) {
        return { streams: [] };
    }
});

// Routes with generic names
app.get('/manifest.json', (req, res) => {
    res.json(manifest);
});

app.get('/catalog/:type/:id/:extra?.json', async (req, res) => {
    try {
        const { type, id, extra } = req.params;
        const extraObj = extra ? JSON.parse(decodeURIComponent(extra)) : {};
        
        const addonInterface = builder.getInterface();
        const result = await addonInterface.catalog.handler({ type, id, extra: extraObj });
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: 'Service temporarily unavailable' });
    }
});

app.get('/stream/:type/:id.json', async (req, res) => {
    try {
        const { type, id } = req.params;
        
        const addonInterface = builder.getInterface();
        const result = await addonInterface.stream.handler({ type, id });
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: 'Stream temporarily unavailable' });
    }
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'operational',
        service: 'active',
        premium: !!ODDOT_KEY,
        timestamp: new Date().toISOString()
    });
});

app.get('/', (req, res) => {
    res.json({
        message: 'Personal Media Addon - Operational',
        endpoint: `${req.protocol}://${req.get('host')}/manifest.json`
    });
});

// Standard export
module.exports = app;
