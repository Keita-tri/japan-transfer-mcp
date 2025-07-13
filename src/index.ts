#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from 'zod';
import { get_encoding } from 'tiktoken';
import http from 'http';

import { fetchSuggest, fetchRouteSearch } from './fetcher.js';
import { parseRouteSearchResult } from './parser.js';

// トークンエンコーダーの初期化
const encoder = get_encoding('cl100k_base');

/**
 * 経路検索結果を自然な文章形式でフォーマットする関数
 * @param result - パースされた経路検索結果
 * @param searchUrl - 検索に使用されたURL
 * @param from - 出発地
 * @param to - 到着地
 * @param datetime - 検索日時
 * @returns フォーマットされたMarkdown文字列
 */
function formatRouteSearchResponse(result: any, searchUrl: string, from: string, to: string, datetime: string): string {
    const lines: string[] = [];
    
    // ヘッダー情報
    lines.push(`🚃 **${from}** から **${to}** への経路検索結果`);
    lines.push(`📅 検索日時: ${datetime}`);
    lines.push(`🔗 検索URL: ${searchUrl}`);
    lines.push(`⏰ 検索実行時刻: ${result.searchTime}`);
    lines.push('');
    
    if (!result.routes || result.routes.length === 0) {
        lines.push('❌ 該当する経路が見つかりませんでした。');
        return lines.join('\n');
    }
    
    lines.push(`📋 **${result.routes.length}件の経路が見つかりました**`);
    lines.push('');
    
    // 各経路の詳細
    result.routes.forEach((route: any, index: number) => {
        lines.push(`## 🛤️ 経路${route.routeNumber}: ${route.timeInfo.departure} → ${route.timeInfo.arrival}`);
        
        // 基本情報
        const basicInfo = [];
        if (route.totalTime) {
            const hours = Math.floor(route.totalTime / 60);
            const minutes = route.totalTime % 60;
            basicInfo.push(`⏱️ 所要時間: ${hours > 0 ? `${hours}時間` : ''}${minutes}分`);
        }
        if (route.transfers !== undefined) {
            basicInfo.push(`🔄 乗換: ${route.transfers}回`);
        }
        if (route.fareInfo?.total) {
            basicInfo.push(`💰 運賃: ${route.fareInfo.total.toLocaleString()}円`);
        }
        if (route.totalDistance) {
            basicInfo.push(`📏 距離: ${route.totalDistance}km`);
        }
        
        if (basicInfo.length > 0) {
            lines.push(basicInfo.join(' | '));
        }
        
        // タグ情報
        if (route.tags && route.tags.length > 0) {
            const tagText = route.tags.map((tag: any) => {
                switch (tag.type) {
                    case 'fast': return '⚡早い';
                    case 'comfortable': return '😌楽';
                    case 'cheap': return '💰安い';
                    case 'car': return '🚗車';
                    default: return tag.label;
                }
            }).join(' ');
            lines.push(`🏷️ ${tagText}`);
        }
        
        // CO2情報
        if (route.co2Info) {
            lines.push(`🌱 CO2排出量: ${route.co2Info.amount}${route.co2Info.reductionRate ? ` (${route.co2Info.comparison}${route.co2Info.reductionRate}削減)` : ''}`);
        }
        
        lines.push('');
        
        // 経路詳細
        if (route.segments && route.segments.length > 0) {
            lines.push('### 📍 経路詳細');
            
            route.segments.forEach((segment: any) => {
                if (segment.type === 'station' && segment.station) {
                    const station = segment.station;
                    let stationLine = '';
                    
                    switch (station.type) {
                        case 'start': stationLine = `🚩 **出発**: ${station.name}`; break;
                        case 'end': stationLine = `🏁 **到着**: ${station.name}`; break;
                        case 'transfer': stationLine = `🔄 **乗換**: ${station.name}`; break;
                        default: stationLine = `📍 ${station.name}`;
                    }
                    if (station.platform) stationLine += ` (${station.platform})`;
                    if (station.weather) {
                        const weatherIcons: Record<string, string> = { 'sunny': '☀️', 'cloudy': '☁️', 'rainy': '🌧️', 'snowy': '❄️' };
                        stationLine += ` ${weatherIcons[station.weather.condition] || '🌤️'}`;
                    }
                    lines.push(stationLine);
                    
                } else if (segment.type === 'transport' && segment.transport) {
                    const transport = segment.transport;
                    const transportIcons: Record<string, string> = { 'train': '🚃', 'subway': '🚇', 'bus': '🚌', 'car': '🚗', 'taxi': '🚕', 'walk': '🚶' };
                    let transportLine = `${transportIcons[transport.type] || '🚃'} ${transport.lineName}`;
                    
                    const timeText = [];
                    if (transport.timeInfo?.departure && transport.timeInfo?.arrival) timeText.push(`${transport.timeInfo.departure}-${transport.timeInfo.arrival}`);
                    if (transport.timeInfo?.duration) timeText.push(`${transport.timeInfo.duration}分`);
                    if (timeText.length > 0) transportLine += ` (${timeText.join(', ')})`;
                    if (transport.fare) transportLine += ` 💰${transport.fare}円`;
                    if (transport.distance) transportLine += ` 📏${transport.distance}`;
                    
                    lines.push(`  ${transportLine}`);
                }
            });
        }
        
        if (route.routeNotices && route.routeNotices.length > 0) {
            lines.push('');
            lines.push('### ⚠️ 注意事項');
            route.routeNotices.forEach((notice: any) => {
                lines.push(`- ${notice.title}${notice.description && notice.description !== notice.title ? `: ${notice.description}` : ''}`);
            });
        }
        
        lines.push('\n---');
    });
    
    return lines.join('\n');
}

/**
 * MCPサーバーのメインクラス
 */
class JapanTransferServer {
    private server: McpServer;
    private activeTransports: Map<http.ServerResponse, SSEServerTransport> = new Map();

    constructor() {
        this.server = new McpServer({
            name: "japan-transfer-mcp",
            version: "0.1.0"
        });
        this.registerTools();
    }

    /**
     * MCPサーバーにツールを登録する
     */
    private registerTools() {
        this.server.registerTool("search_station_by_name",
            {
                title: "Search for stations by name",
                description: "Search for stations by name",
                inputSchema: {
                    query: z.string().describe("The name of the station to search for (must be in Japanese)"),
                    maxTokens: z.number().optional().describe("The maximum number of tokens to return"),
                    onlyName: z.boolean().optional().describe("Whether to only return the name of the station. If you do not need detailed information, it is generally recommended to set this to true."),
                }
            },
            async ({ query, maxTokens, onlyName }) => {
                console.log(`[Tool] search_station_by_name called with query: ${query}`);
                try {
                    const response = await fetchSuggest({ query, format: "json" });
                    const railwayPlaces = response.R?.map(p => onlyName ? p.poiName : `${p.poiName}（${p.prefName}${p.cityName || ''}, citycode: ${p.cityCode ?? '不明'}, よみ: ${p.poiYomi}）`) || [];
                    const busPlaces = response.B?.map(p => onlyName ? p.poiName : `${p.poiName}（${p.prefName}${p.cityName || ''}, citycode: ${p.cityCode ?? '不明'}, よみ: ${p.poiYomi}）`) || [];
                    const spots = response.S?.map(p => onlyName ? p.poiName : `${p.poiName}（${p.prefName}${p.cityName || ''}${p.address || ''}, citycode: ${p.cityCode ?? '不明'}, よみ: ${p.poiYomi}）`) || [];

                    const merged = [];
                    const maxLen = Math.max(railwayPlaces.length, busPlaces.length, spots.length);
                    for (let i = 0; i < maxLen; i++) {
                        if (railwayPlaces[i]) merged.push(railwayPlaces[i]);
                        if (busPlaces[i]) merged.push(busPlaces[i]);
                        if (spots[i]) merged.push(spots[i]);
                    }
                    
                    let result = "";
                    const max = typeof maxTokens === "number" ? maxTokens : Infinity;
                    for (const item of merged) {
                        const next = (result ? "," : "") + item;
                        if (encoder.encode(result + next).length > max) break;
                        result += next;
                    }
                    console.log(`[Tool] search_station_by_name succeeded. Returning ${merged.length} results.`);
                    return { content: [{ type: "text", text: result }] };
                } catch (error) {
                    console.error("[Tool Error] search_station_by_name failed:", error);
                    return { content: [{ type: "text", text: `Contact retrieval error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
                }
            }
        );

        this.server.registerTool("search_route_by_station_name",
            {
                title: "Search for routes by station name",
                description: "Search for routes by station name",
                inputSchema: {
                    from: z.string().describe("The name of the departure station. The value must be a name obtained from search_station_by_name."),
                    to: z.string().describe("The name of the arrival station. The value must be a name obtained from search_station_by_name."),
                    datetimeType: z.enum(["departure", "arrival", "first", "last"]).describe("The type of datetime to use for the search"),
                    datetime: z.string().optional().describe("The datetime to use for the search. Format: YYYY-MM-DD HH:MM:SS. If not provided, the current time in Japan will be used."),
                    maxTokens: z.number().optional().describe("The maximum number of tokens to return"),
                },
            },
            async ({ from, to, datetimeType, datetime, maxTokens }) => {
                console.log(`[Tool] search_route_by_station_name called: ${from} -> ${to}`);
                try {
                    if (!datetime) {
                        const now = new Date();
                        const jpNow = new Date(now.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }));
                        const pad = (n: number) => n.toString().padStart(2, "0");
                        datetime = `${jpNow.getFullYear()}-${pad(jpNow.getMonth() + 1)}-${pad(jpNow.getDate())} ${pad(jpNow.getHours())}:${pad(jpNow.getMinutes())}:${pad(jpNow.getSeconds())}`;
                    }
                    
                    const datePart = datetime.split(" ")[0];
                    const timePart = datetime.split(" ")[1];
                    const [year, month, day] = datePart.split("-").map(Number);
                    const [hour, minute] = timePart.split(":").map(Number);
                    
                    const isFromBusStop = from.includes("〔") || from.includes("［");
                    const isToBusStop = to.includes("〔") || to.includes("［");
                    
                    const response = await fetchRouteSearch({
                        eki1: from, eki2: to, Dyy: year, Dmm: month, Ddd: day, Dhh: hour,
                        Dmn1: Math.floor(minute / 10), Dmn2: minute % 10,
                        Cway: { "departure": 0, "arrival": 1, "first": 2, "last": 3 }[datetimeType] as 0 | 1 | 2 | 3,
                        via_on: -1, Cfp: 1, Czu: 2, C7: 1, C2: 0, C3: 0, C1: 0, cartaxy: 1,
                        bikeshare: 1, sort: "time", C4: 5, C5: 0, C6: 2, S: "検索", Cmap1: "",
                        rf: "nr", pg: 0, eok1: isFromBusStop ? "B-" : "R-",
                        eok2: isToBusStop ? "B-" : "R-", Csg: 1
                    });
                    
                    const parsedResult = parseRouteSearchResult(response.data);
                    let resultText = formatRouteSearchResponse(parsedResult, response.url, from, to, datetime);
                    
                    if (maxTokens) {
                        const tokens = encoder.encode(resultText);
                        if (tokens.length > maxTokens) {
                            const limitedResult = { ...parsedResult, routes: parsedResult.routes.slice(0, 1) };
                            resultText = formatRouteSearchResponse(limitedResult, response.url, from, to, datetime);
                        }
                    }
                    
                    console.log("[Tool] search_route_by_station_name succeeded.");
                    return { content: [{ type: "text", text: resultText }] };
                } catch (error) {
                    console.error("[Tool Error] search_route_by_station_name failed:", error);
                    return { content: [{ type: "text", text: `Route search error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
                }
            }
        );
    }

    /**
     * HTTPサーバーを起動し、リクエストを待ち受ける
     * @param port - リッスンするポート番号
     */
    public async start(port: number) {
        const httpServer = http.createServer(async (req, res) => {
            console.log(`[HTTP] Request received: ${req.method} ${req.url}`);
            
            // CORSヘッダーを追加
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

            // プリフライトリクエストへの対応
            if (req.method === 'OPTIONS') {
                console.log("[HTTP] Responding to OPTIONS preflight request.");
                res.writeHead(204);
                res.end();
                return;
            }

            // SSE接続用の /events エンドポイント
            if (req.method === "GET" && req.url === "/events") {
                console.log("[SSE] New SSE connection established.");
                const transport = new SSEServerTransport("/messages", res);
                this.activeTransports.set(res, transport);
                
                await this.server.connect(transport);

                res.on("close", () => {
                    console.log("[SSE] SSE connection closed.");
                    this.activeTransports.delete(res);
                });
                return;
            }

            // クライアントからのメッセージ受信用エンドポイント
            if (req.method === "POST" && req.url?.startsWith("/messages")) {
                console.log("[POST /messages] Message received.");
                let transport;
                for (const [savedRes, savedTransport] of this.activeTransports.entries()) {
                    if (!savedRes.closed) {
                        transport = savedTransport;
                        break;
                    }
                }

                if (!transport) {
                    console.error("[POST /messages] No active SSE transport found.");
                    res.writeHead(400).end("No active SSE transport found for this message.");
                    return;
                }
                
                await transport.handlePostMessage(req, res);
                console.log("[POST /messages] Message handled.");
                return;
            }
            
            // Railwayヘルスチェック用エンドポイント
            if (req.url === "/") {
                console.log("[HTTP] Health check request received.");
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end("MCP Server is running.");
                return;
            }

            console.log(`[HTTP] 404 Not Found for ${req.method} ${req.url}`);
            res.writeHead(404).end("Not Found");
        });

        httpServer.listen(port, '0.0.0.0', () => {
            console.log(`[SYSTEM] Server is listening on port ${port}. Ready to accept all incoming connections.`);
            console.log(`[SYSTEM] SSE Endpoint: http://localhost:${port}/events`);
        });
    }
}

// --- サーバーの起動 ---
const port = parseInt(process.env.PORT || "3000", 10);
const mcpServer = new JapanTransferServer();
mcpServer.start(port).catch(error => {
    console.error("[SYSTEM] Failed to start server:", error);
});
