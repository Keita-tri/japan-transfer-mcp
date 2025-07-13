#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from 'zod';
import { get_encoding } from 'tiktoken';
import express from 'express';
import cors from 'cors';

import { fetchSuggest, fetchRouteSearch } from './fetcher.js';
import { parseRouteSearchResult } from './parser.js';

// --- ユーティリティとフォーマット関数 ---
const encoder = get_encoding('cl100k_base');

function formatRouteSearchResponse(result: any, searchUrl: string, from: string, to: string, datetime: string): string {
    const lines: string[] = [];
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
    result.routes.forEach((route: any) => {
        lines.push(`## 🛤️ 経路${route.routeNumber}: ${route.timeInfo.departure} → ${route.timeInfo.arrival}`);
        const basicInfo = [];
        if (route.totalTime) {
            const hours = Math.floor(route.totalTime / 60);
            const minutes = route.totalTime % 60;
            basicInfo.push(`⏱️ 所要時間: ${hours > 0 ? `${hours}時間` : ''}${minutes}分`);
        }
        if (route.transfers !== undefined) basicInfo.push(`🔄 乗換: ${route.transfers}回`);
        if (route.fareInfo?.total) basicInfo.push(`💰 運賃: ${route.fareInfo.total.toLocaleString()}円`);
        if (route.totalDistance) basicInfo.push(`📏 距離: ${route.totalDistance}km`);
        if (basicInfo.length > 0) lines.push(basicInfo.join(' | '));
        
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
        
        if (route.co2Info) {
            lines.push(`🌱 CO2排出量: ${route.co2Info.amount}${route.co2Info.reductionRate ? ` (${route.co2Info.comparison}${route.co2Info.reductionRate}削減)` : ''}`);
        }
        
        lines.push('');
        
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
        lines.push('\n---');
    });
    return lines.join('\n');
}

// --- MCPサーバーとツールの設定 ---
const server = new McpServer({
    name: "japan-transfer-mcp",
    version: "0.1.0"
});

server.registerTool("search_station_by_name",
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
        console.log(`[Tool] search_station_by_name called with query: "${query}"`);
        try {
            const response = await fetchSuggest({ query, format: "json" });
            const railwayPlaces = response.R?.map(p => onlyName ? p.poiName : `${p.poiName}(${p.prefName}${p.cityName || ''})`) || [];
            const busPlaces = response.B?.map(p => onlyName ? p.poiName : `${p.poiName}(${p.prefName}${p.cityName || ''})`) || [];
            const spots = response.S?.map(p => onlyName ? p.poiName : `${p.poiName}(${p.prefName}${p.cityName || ''})`) || [];
            const merged = [...railwayPlaces, ...busPlaces, ...spots];
            
            let result = "";
            const max = typeof maxTokens === "number" ? maxTokens : Infinity;
            for (const item of merged) {
                const next = (result ? "," : "") + item;
                if (encoder.encode(result + next).length > max) break;
                result += next;
            }
            console.log(`[Tool] search_station_by_name succeeded.`);
            return { content: [{ type: "text", text: result }] };
        } catch (error) {
            console.error("[Tool Error] search_station_by_name failed:", error);
            return { content: [{ type: "text", text: `Station search error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
        }
    }
);

server.registerTool("search_route_by_station_name",
    {
        title: "Search for routes by station name",
        description: "Search for routes by station name",
        inputSchema: {
            from: z.string().describe("The name of the departure station."),
            to: z.string().describe("The name of the arrival station."),
            datetimeType: z.enum(["departure", "arrival", "first", "last"]).describe("The type of datetime to use for the search"),
            datetime: z.string().optional().describe("The datetime for the search. Format: YYYY-MM-DD HH:MM:SS."),
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
            
            const [datePart, timePart] = datetime.split(" ");
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
            
            if (maxTokens && encoder.encode(resultText).length > maxTokens) {
                const limitedResult = { ...parsedResult, routes: parsedResult.routes.slice(0, 1) };
                resultText = formatRouteSearchResponse(limitedResult, response.url, from, to, datetime);
            }
            
            console.log("[Tool] search_route_by_station_name succeeded.");
            return { content: [{ type: "text", text: resultText }] };
        } catch (error) {
            console.error("[Tool Error] search_route_by_station_name failed:", error);
            return { content: [{ type: "text", text: `Route search error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
        }
    }
);

// --- Expressサーバーの設定 ---
const app = express();
app.use(cors());
app.use(express.json());

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined,
});

server.connect(transport).catch(error => {
  console.error("[SYSTEM] MCP Server failed to connect to transport:", error);
});

// --- エンドポイントの定義 ---

// Railwayヘルスチェック用エンドポイント
app.get("/", (req, res) => {
  console.log(`[HEALTH] GET / received. Responding 200 OK.`);
  res.status(200).send("OK");
});

// MCPメインエンドポイント
app.post("/mcp", async (req, res) => {
  console.log(`[MCP] POST /mcp received.`);
  try {
    console.log("[MCP] Request body:", JSON.stringify(req.body, null, 2));
    await transport.handleRequest(req, res, req.body);
    console.log("[MCP] Request handled successfully.");
  } catch (error) {
    console.error("[MCP] Error handling POST request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: (req.body as any)?.id || null,
      });
    }
  }
});

// POST以外のメソッドを処理するエンドポイント
app.all("/mcp", (req, res) => {
    // POSTリクエストはこのハンドラに到達する前に処理されるため、ここに来るのはPOST以外
    console.log(`[MCP] ${req.method} /mcp received. Responding 405 Method Not Allowed.`);
    res.setHeader('Allow', 'POST'); // 許可するメソッドをヘッダーで示す
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: `Method ${req.method} not allowed. Please use POST.` },
      id: null,
    });
});

// --- サーバーの起動 ---
const port = parseInt(process.env.PORT || "3000", 10);
const httpServer = app.listen(port, '0.0.0.0', () => {
  console.log(`[SYSTEM] Server is listening on port ${port}. Ready for connections.`);
});

// --- Graceful Shutdown ---
const shutdown = async (signal: string) => {
    console.log(`[SYSTEM] ${signal} signal received. Shutting down gracefully.`);
    await server.close();
    httpServer.close(() => {
        console.log('[SYSTEM] HTTP server closed.');
        process.exit(0);
    });
};

process.on("SIGINT", () => shutdown('SIGINT'));
process.on("SIGTERM", () => shutdown('SIGTERM'));
