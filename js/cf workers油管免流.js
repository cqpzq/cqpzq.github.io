// 获取 YouTube M3U8 URL
async function getPlayUrl(rid, proxyUrl) {
	const url = "https://youtubei.googleapis.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
	const body = JSON.stringify({
		"videoId": rid,
		"context": {
			"client": {
				"hl": "en",
				"gl": "US",
				"clientName": "ANDROID_TESTSUITE",
				"clientVersion": "1.9",
				"androidSdkVersion": 31
			}
		}
	});
	const headers = {
		"User-Agent": "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/86.0.4240.198 Safari/537.36",
	};

	const response = await fetch(url, {
		method: "POST",
		headers: headers,
		body: body,
		cf: {
			timeout: 30000
		}
	});

	const data = await response.json();
	// console.log(data); // 打印返回的 JSON 数据
	if (data.streamingData) {
		// 处理M3U8
		let m3u8Url; // 确保 m3u8Url 在函数作用域内声明
		if (data.streamingData.hlsManifestUrl) {
			if (typeof data.streamingData.hlsManifestUrl === 'string') {
				m3u8Url = data.streamingData.hlsManifestUrl;
			} else if (Array.isArray(data.streamingData.hlsManifestUrl)) {
				m3u8Url = data.streamingData.hlsManifestUrl[0];
			} else {
				return "404-未找到播放地址";
			}
			const m3u8Content = await getM3U8(m3u8Url, proxyUrl);
			return "m3u-" + m3u8Content;
		}
		// 处理DASH
		else if ('adaptiveFormats' in data.streamingData) {
			const mpdContent = await getMPD(rid, proxyUrl, data);
			return "mpd-" + mpdContent;
		} else {
			return "404-未找到播放地址";
		}
	} else {
		return "404-未找到播放地址";
	}
}

// 获取 M3U8 内容
async function getM3U8(url, proxyUrl) {
	const response = await fetch(url);
	const lines = await response.text();
	let m3u8Str = "";
	const linesArray = lines.split("\n");
	for (const line of linesArray) {
		if (line.length > 0 && !line.startsWith("#")) {
			if (line.endsWith(".ts")) {
				m3u8Str += proxyUrl + "/proxyMedia?url=" + btoa(line) + "\n";
			} else {
				m3u8Str += proxyUrl + "/proxyM3u8?url=" + btoa(line) + "\n";
			}
		} else {
			m3u8Str += line + "\n";
		}
	}
	return m3u8Str.trim();
}

// 获取 MPD 内容
async function getMPD(rid, proxyUrl, data) {
	const response = await fetch("https://www.youtube.com/watch?v=" + rid);
	const lines = await response.text();
	const scriptUrlMatch = lines.match(/<script\s*src="([^"]+player[^"]+js)"/);
	if (scriptUrlMatch && scriptUrlMatch[1]) {
		const newResponse = await fetch('https://www.youtube.com/' + scriptUrlMatch[1]);
		const newLines = await newResponse.text();
		let funcName;
		try {
			funcName = newLines.match(/,\s*encodeURIComponent\((\w{2})/i)[1];
		} catch {
			try {
				funcName = newLines.match(/(?:\b|[^a-zA-Z0-9$])([a-zA-Z0-9$]{2,3})\s*=\s*function\(\s*a\s*\)\s*{\s*a\s*=\s*a\.split\(\s*""\s*\)/i)[1];
			} catch (error) {
				console.error('Regex error:', error);
				return "404-未找到匹配的脚本";
			}
		}
		const instructions = await getFunctionCode(funcName, newLines)
		const dashList = data.streamingData.adaptiveFormats;
		let duration = 0;
		let audioinfo = '';
		let videoinfo = '';

		for (const item of dashList) {
			// 获取 mpd 所需参数
			if (duration === 0) {
				duration = Math.floor(parseInt(item.approxDurationMs) / 1000);
			}
			const typeinfo = item.mimeType.split(';');
			const mimeType = typeinfo[0];
			const codecs = typeinfo[1].split('=')[1].trim().replace(/"/g, '');
			const bandwidth = item.averageBitrate;
			const avid = item.itag;
			let baseUrl;

			try {
				baseUrl = proxyUrl + "/proxyMedia?url=" + btoa(item.url.replace(/%0C/g, ''));
			} catch (error) {
				const sigSrc = decodeURIComponent(item.signatureCipher.match(/s=(.*?)&sp=sig/)[1]);
				baseUrl = proxyUrl + "/proxyMedia?url=" + btoa(`${decodeURIComponent(item.signatureCipher.match(/(http.*)/)[1])}&sig=${decodeSignature(sigSrc, instructions)}`);
			}

			if (mimeType.startsWith('video')) {
				const frameRate = item.fps;
				const height = item.height;
				const width = item.width;
				videoinfo += `      <Representation id="${avid}" bandwidth="${bandwidth}" codecs="${codecs}" mimeType="${mimeType}" height="${height}" width="${width}" frameRate="${frameRate}" maxPlayoutRate="1" startWithSAP="1">
        <BaseURL>${baseUrl}</BaseURL>
        <SegmentBase indexRange="${item.indexRange.start}-${item.indexRange.end}">
            <Initialization range="${item.initRange.start}-${item.initRange.end}"/>
        </SegmentBase>
        </Representation>\n`;
			} else {
				const audioSamplingRate = item.audioSampleRate;
				audioinfo += `      <Representation id="${avid}" bandwidth="${bandwidth}" codecs="${codecs}" mimeType="${mimeType}" subsegmentAlignment="true" audioSamplingRate="${audioSamplingRate}">
        <BaseURL>${baseUrl}</BaseURL>
        <SegmentBase indexRange="${item.indexRange.start}-${item.indexRange.end}">
            <Initialization range="${item.initRange.start}-${item.initRange.end}"/>
        </SegmentBase>
        </Representation>\n`;
			}
		}

		const videoAdaptationSet = videoinfo ? `<AdaptationSet lang="chi">
      <ContentComponent contentType="video"/>
      ${videoinfo.trim()}
    </AdaptationSet>` : '';

		const audioAdaptationSet = audioinfo ? `<AdaptationSet lang="chi">
      <ContentComponent contentType="audio"/>
      ${audioinfo.trim()}
    </AdaptationSet>` : '';

		const mpdContent = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns="urn:mpeg:dash:schema:mpd:2011" xsi:schemaLocation="urn:mpeg:dash:schema:mpd:2011 DASH-MPD.xsd" type="static" mediaPresentationDuration="PT${duration}S" minBufferTime="PT1.500S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">
  <Period duration="PT${duration}S" start="PT0S">
      ${videoAdaptationSet}
      ${audioAdaptationSet}
  </Period>
</MPD>`;
		return mpdContent.trim().replace(/&/g, '&amp;');
	} else {
		return "404-未找到匹配的脚本";
	}
}

// 获取 JS 解密命令
async function getFunctionCode(funcName, src) {
	// 使用正则表达式匹配函数代码
	const funcRegex = new RegExp(`${funcName}=function\\([a-z]+\\){(.*?)}`, 's');
	const funcMatch = src.match(funcRegex);

	if (funcMatch) {
		const jsCode = funcMatch[1];

		// 匹配并提取 JavaScript 中的函数调用
		const callRegex = /([a-z0-9$]{2})\.([a-z0-9]{2})\([^,]+,(\d+)\)/gi;
		const matches = Array.from(jsCode.matchAll(callRegex));

		if (matches.length > 0) {
			const funcList = matches.map(m => m[2]);
			const funcPattern = new RegExp(`(${funcList.map(f => f.replace(/[$]/g, '\\$')).join('|')}):function(.*?)\\}`, 'gs');
			const newMatches = Array.from(src.matchAll(funcPattern));

			const functions = {};
			for (const m of newMatches) {
				if (m[2].includes('splice')) {
					functions[m[1]] = 'splice';
				} else if (m[2].includes('a.length')) {
					functions[m[1]] = 'swap';
				} else if (m[2].includes('reverse')) {
					functions[m[1]] = 'reverse';
				}
			}

			const instructions = [];
			for (const m of matches) {
				const name = m[2];
				const arg = m[3];
				if (functions[name]) {
					instructions.push([functions[name], arg]);
				}
			}
			return instructions;
		}
	}
	return null;
}

// 解密 Signature
async function decodeSignature(signature, instructions) {
	signature = signature.split(''); // 将字符串转换为数组，以便进行交换操作
	for (const opt of instructions) {
		const command = opt[0];
		const value = parseInt(opt[1]);
		if (command === 'swap') {
			// 执行 swap 操作
			const temp = signature[0];
			signature[0] = signature[value % signature.length];
			signature[value % signature.length] = temp;
		} else if (command === 'splice') {
			// 执行 splice 操作
			signature = signature.slice(value);
		} else if (command === 'reverse') {
			// 执行 reverse 操作
			signature.reverse();
		}
	}
	return signature.join('')
		.trim();
}

// 处理请求
addEventListener("fetch", (event) => {
	event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
	const localUrl = new URL(request.url);
	const parsedLocalUrl = new URL(localUrl.href);
	const proxyUrl = parsedLocalUrl.protocol + "//" + parsedLocalUrl.host
	const path = localUrl.pathname;
	const params = localUrl.searchParams;
	const urlStr = params.get("url");

	// 获取 YouTube 内容
	if (path === "/live") {
		let rid = "";
		let url = new URL(urlStr);
		if (urlStr.includes('v=')) {
			rid = url.searchParams.get('v');
		} else {
			let pathParts = url.pathname.split('/')
				.filter(part => part.length > 0);
			rid = pathParts[pathParts.length - 1];
		}
		let content = await getPlayUrl(rid, proxyUrl);
		if (content.startsWith('404-') || content === "") {
			let errorMessage = content;
			if (content === "") {
				errorMessage = "404-Not Found";
			}
			return new Response(errorMessage.substr(4), {
				status: 404
			});
		} else if (content.startsWith('mpd-')) {
			return new Response(content.substr(4), {
				headers: {
					"Content-Type": "application/dash+xml",
					"Content-Disposition": "attachment; filename=youtube.mpd",
				},
			});
		} else if (content.startsWith('m3u-')) {
			return new Response(content.substr(4), {
				headers: {
					"Content-Type": "application/vnd.apple.mpegurl",
					"Content-Disposition": "attachment; filename=youtube.m3u8",
				},
			});
		} else {
			return new Response(content, {
				status: 404
			});
		}


	}

	// 代理 YouTube M3U8
	else if (path === "/proxyM3u8") {
		const url = atob(urlStr);
		const content = await getM3U8(url, proxyUrl);
		if (content.startsWith('404-') || content === "") {
			let errorMessage = content;
			if (content === "") {
				errorMessage = "404-Not Found";
			}
			return new Response(errorMessage.substr(4), {
				status: 404
			});
		}
		return new Response(content, {
			headers: {
				"Content-Type": "application/vnd.apple.mpegurl",
				"Content-Disposition": "attachment; filename=youtube.m3u8",
			},
		});
	}

	// 代理 YouTube 切片
	else if (path === "/proxyMedia") {
		const url = atob(urlStr);
		const selfHeaders = Object.fromEntries(request.headers);
		const responseHeaders = new Headers();

		for (const [key, value] of Object.entries(selfHeaders)) {
			if (key.toLowerCase() === "user-agent" || key.toLowerCase() === "host") {
				continue;
			}
			responseHeaders.set(key, value);
		}

		const response = await fetch(url, {
			headers: responseHeaders
		});
		const contentType = response.headers.get("content-type");
		const statusCode = response.status;

		for (const [key, value] of response.headers) {
			if (key.toLowerCase() === "connection" || key.toLowerCase() === "transfer-encoding") {
				continue;
			}
			if (contentType.toLowerCase() === "application/vnd.apple.mpegurl" || contentType.toLowerCase() === "application/x-mpegurl") {
				if (key.toLowerCase() === "content-length" || key.toLowerCase() === "content-range" || key.toLowerCase() === "accept-ranges") {
					continue;
				}
			}
			responseHeaders.set(key, value);
		}

		const readableStream = new ReadableStream({
			start(controller) {
				const reader = response.body.getReader();

				function read() {
					reader.read()
						.then(({
							done,
							value
						}) => {
							if (done) {
								controller.close();
								return;
							}
							controller.enqueue(value);
							read();
						});
				}

				read();
			},
		});

		return new Response(readableStream, {
			status: statusCode,
			headers: responseHeaders,
		});
	} else {
		return new Response("Not Found", {
			status: 404
		});
	}
}