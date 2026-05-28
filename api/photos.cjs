// Simple Node.js API to scan local photo folders
// Usage: node api/photos.js <folder_path>

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8088;
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg']);

// Vision API config (set via environment variables or .env file)
const VISION_API_BASE = process.env.VISION_API_BASE || 'http://localhost:3000/v1';
const VISION_API_KEY = process.env.VISION_API_KEY || '';
const VISION_MODEL = 'mimo-v2.5';

// Recursively scan for images
function scanDir(dir, maxDepth = 4) {
    let results = [];
    if (maxDepth <= 0) return results;
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                results = results.concat(scanDir(fullPath, maxDepth - 1));
            } else if (IMAGE_EXTS.has(path.extname(entry.name).toLowerCase())) {
                results.push(fullPath);
            }
        }
    } catch (e) { /* skip unreadable dirs */ }
    return results;
}

function scanFolder(folderPath) {
    const absPath = path.resolve(folderPath);
    if (!fs.existsSync(absPath)) {
        return { error: `文件夹不存在: ${absPath}`, files: [] };
    }

    const stat = fs.statSync(absPath);
    if (!stat.isDirectory()) {
        return { error: `不是文件夹: ${absPath}`, files: [] };
    }

    // Recursively find all images
    const allFiles = scanDir(absPath);

    const files = allFiles
        .map(f => {
            // Get relative path from /opt/1panel or /home/ctyun etc
            let relFromRoot = f;
            let urlPath = '';
            if (f.startsWith('/opt/1panel/')) {
                relFromRoot = f;
                urlPath = `/opt1panel/${path.relative('/opt/1panel', f)}`;
            } else if (f.startsWith('/home/')) {
                const parts = f.split('/');
                urlPath = `/home/${parts[2]}/${path.relative(path.join('/home', parts[2]), f)}`;
            } else {
                urlPath = `/abs/${encodeURIComponent(f)}`;
            }
            return {
                name: path.basename(f),
                path: f,
                url: urlPath
            };
        })
        .sort((a, b) => b.name.localeCompare(a.name));

    // Return all photos (random selection happens on frontend)
    return { folder: absPath, count: files.length, files };
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // API: list photos in folder
    if (url.pathname === '/api/photos') {
        const folder = url.searchParams.get('folder') || '/home/ctyun/photos';
        const result = scanFolder(folder);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
        return;
    }

    // API: health check for vision model
    if (url.pathname === '/api/health') {
        (async () => {
            try {
                const resp = await fetch(`${VISION_API_BASE}/chat/completions`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${VISION_API_KEY}`
                    },
                    body: JSON.stringify({
                        model: VISION_MODEL,
                        messages: [{ role: 'user', content: 'hi' }],
                        max_tokens: 5
                    })
                });
                const data = await resp.json();
                const ok = !data.error && data.choices?.length > 0;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok, model: VISION_MODEL, error: data.error?.message || null }));
            } catch (e) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, model: VISION_MODEL, error: e.message }));
            }
        })();
        return;
    }

    // API: analyze photos with vision model
    if (url.pathname === '/api/analyze' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { imageUrls } = JSON.parse(body);
                if (!imageUrls || !imageUrls.length) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: '缺少 imageUrls' }));
                    return;
                }

                // Convert URLs to filesystem paths and read as base64
                const imageContent = [];
                for (const imgUrl of imageUrls.slice(0, 4)) {
                    // URL format: http://localhost:8088/home/ctyun/photos/xxx.jpg
                    // or http://localhost:8088/opt1panel/...
                    let absPath = '';
                    if (imgUrl.includes('/home/')) {
                        absPath = '/home/' + decodeURIComponent(imgUrl.split('/home/').pop());
                    } else if (imgUrl.includes('/opt1panel/')) {
                        absPath = '/opt/1panel/' + decodeURIComponent(imgUrl.split('/opt1panel/').pop());
                    }
                    if (absPath && fs.existsSync(absPath)) {
                        const buf = fs.readFileSync(absPath);
                        const ext = path.extname(absPath).toLowerCase();
                        const mime = { '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.gif':'image/gif','.webp':'image/webp','.bmp':'image/bmp' }[ext] || 'image/jpeg';
                        imageContent.push({
                            type: 'image_url',
                            image_url: { url: `data:${mime};base64,${buf.toString('base64')}` }
                        });
                        console.log(`  📷 ${path.basename(absPath)} (${(buf.length/1024).toFixed(0)}KB)`);
                    }
                }

                if (imageContent.length === 0) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: '未找到有效图片' }));
                    return;
                }

                const prompt = `你是专业的摄影评论家。面前有 ${imageContent.length} 张照片需要你逐一分析。

对每张照片：
1. 写一段简短点评（20-40字），涵盖构图、光影、色彩、情绪中的 1-2 个方面
2. 给一个评分（9.0-9.9）
3. 给 2-4 个标签，从以下类型中选择：
   - 场景(scene): 风景、人像、动物、建筑、美食、街拍、夜景、花卉、天空、海洋、森林、室内
   - 情绪(mood): 治愈、宁静、震撼、浪漫、孤独、欢乐、神秘、温暖、忧郁、梦幻
   - 风格(style): 暖色调、冷色调、光影、氛围感、极简、复古、高饱和、黑白、胶片感
   - 内容(nsfw): 只要图片中的人物衣着较少、有性感/泳装/比基尼/露肩/露腰/丝袜/黑丝/短裙/低胸/魅惑/诱惑等元素，或者动漫角色有上述特征，都必须加 nsfw 标签

严格按以下格式返回，每张照片一条，不要多余内容：
[1] 点评内容 | 评分: 9.X | 标签: 标签1,标签2,标签3
[2] 点评内容 | 评分: 9.X | 标签: 标签1,标签2
...

最后一行写选片总结（3-5句话），必须做到：
1. 总体风格和质量评价
2. 明确指出哪一张是最佳的（用编号），从构图、色彩、情绪感染力、完成度等角度说明为什么最好——注意不要总是选第一张，要根据实际画面质量客观判断
3. 给出选片建议
格式：
[总结] 详细总结文字，其中明确选出最佳照片编号和理由

标签类型映射（按顺序匹配）：scene类:风景、人像、动物、建筑、美食、街拍、夜景、花卉、天空、海洋、森林、室内; mood类:治愈、宁静、震撼、浪漫、孤独、欢乐、神秘、温暖、忧郁、梦幻; style类:暖色调、冷色调、光影、氛围感、极简、复古、高饱和、黑白、胶片感; nsfw类:nsfw`;

                const apiResp = await fetch(`${VISION_API_BASE}/chat/completions`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${VISION_API_KEY}`
                    },
                    body: JSON.stringify({
                        model: VISION_MODEL,
                        messages: [{
                            role: 'user',
                            content: [{ type: 'text', text: prompt }, ...imageContent]
                        }],
                        max_tokens: 3000,
                        temperature: 0.7
                    })
                });

                const apiData = await apiResp.json();
                console.log('Vision API response:', JSON.stringify(apiData).substring(0, 500));
                let content = apiData.choices?.[0]?.message?.content || '';
                // Handle content filter or empty response
                if (apiData.choices?.[0]?.finish_reason === 'content_filter' || content.includes('rejected') || content.includes('high risk')) {
                    console.warn('Content filtered, retrying individually...');
                    // Try analyzing photos in parallel (max 4)
                    const toAnalyze = imageContent.slice(0, 4);
                    const individualResults = await Promise.all(toAnalyze.map(async (_, i) => {
                        try {
                            const singleResp = await fetch(`${VISION_API_BASE}/chat/completions`, {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Authorization': `Bearer ${VISION_API_KEY}`
                                },
                                body: JSON.stringify({
                                    model: VISION_MODEL,
                                    messages: [{
                                        role: 'user',
                                        content: [{ type: 'text', text: prompt }, imageContent[i]]
                                    }],
                                    max_tokens: 500,
                                    temperature: 0.7
                                })
                            });
                            const singleData = await singleResp.json();
                            const singleContent = singleData.choices?.[0]?.message?.content || '';
                            if (singleData.choices?.[0]?.finish_reason === 'content_filter' || singleContent.includes('rejected') || singleContent.includes('high risk')) {
                                return `[${i+1}] 此图触发内容安全过滤，可能包含敏感/NSFW内容 | 评分: -.- | 标签: nsfw`;
                            }
                            return singleContent;
                        } catch {
                            return `[${i+1}] 分析失败 | 评分: -.- | 标签: nsfw`;
                        }
                    }));
                    // Pad results for remaining photos
                    for (let i = toAnalyze.length; i < imageContent.length; i++) {
                        individualResults.push(`[${i+1}] 未分析 | 评分: -.- | 标签: nsfw`);
                    }
                    content = individualResults.join('\n') + '\n[总结] 部分照片触发了内容安全过滤，已标记为NSFW。建议检查图片内容是否适合展示。';
                }

                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ analysis: content, model: VISION_MODEL }));
            } catch (e) {
                console.error('Vision API error:', e);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // Serve actual image files from /opt/1panel/
    if (url.pathname.startsWith('/opt1panel/')) {
        const filePath = path.join('/opt/1panel', decodeURIComponent(url.pathname.slice(11)));
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            const ext = path.extname(filePath).toLowerCase();
            const mimeTypes = {
                '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                '.png': 'image/png', '.gif': 'image/gif',
                '.webp': 'image/webp', '.bmp': 'image/bmp',
                '.svg': 'image/svg+xml'
            };
            res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
            fs.createReadStream(filePath).pipe(res);
            return;
        }
        res.writeHead(404);
        res.end('Not found');
        return;
    }

    // Serve files from /home/ctyun/
    if (url.pathname.startsWith('/home/')) {
        const decoded = decodeURIComponent(url.pathname);
        const filePath = decoded;
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            const ext = path.extname(filePath).toLowerCase();
            const mimeTypes = {
                '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                '.png': 'image/png', '.gif': 'image/gif',
                '.webp': 'image/webp', '.bmp': 'image/bmp',
                '.svg': 'image/svg+xml'
            };
            res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
            fs.createReadStream(filePath).pipe(res);
            return;
        }
        res.writeHead(404);
        res.end('Not found');
        return;
    }

    res.writeHead(404);
    res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`📷 Photo API running at http://0.0.0.0:${PORT}`);
    console.log(`   API: http://localhost:${PORT}/api/photos?folder=/home/ctyun/photos`);
});
