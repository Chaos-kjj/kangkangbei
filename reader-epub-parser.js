(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.parseEpubToText = api.parseEpubToText;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const UTF8_FLAG = 0x0800;
    const ZIP_STORED = 0;
    const ZIP_DEFLATED = 8;

    async function parseEpubToText(arrayBuffer, options = {}) {
        const zip = await readZipEntries(arrayBuffer);
        const containerXml = await zip.getText('META-INF/container.xml');
        if (!containerXml) {
            throw new Error('EPUB 缺少 META-INF/container.xml');
        }

        const packagePath = getContainerPackagePath(containerXml);
        if (!packagePath) {
            throw new Error('EPUB 未声明 OPF package 文件');
        }

        const packageXml = await zip.getText(packagePath);
        if (!packageXml) {
            throw new Error('EPUB 缺少 OPF package 文件');
        }

        const packageDir = getDirectory(packagePath);
        const manifest = parseManifest(packageXml, packageDir);
        const spine = parseSpine(packageXml);
        const labels = await parseChapterLabels(zip, manifest);
        const chapterTexts = [];

        for (const spineItem of spine) {
            if (spineItem.linear === 'no') continue;

            const item = manifest.byId.get(spineItem.idref);
            if (!item || !isHtmlManifestItem(item) || isSkippableEpubItem(item)) continue;

            const html = await zip.getText(item.path);
            if (!html) continue;

            const chapterText = htmlToReadableText(html);
            if (!chapterText) continue;

            const label = labels.get(item.path) || item.title || '';
            chapterTexts.push(prependChapterLabel(chapterText, label));
        }

        if (!chapterTexts.length) {
            throw new Error('EPUB 没有找到可阅读正文');
        }

        return chapterTexts.join('\n\n');
    }

    async function readZipEntries(arrayBuffer) {
        const bytes = arrayBuffer instanceof Uint8Array
            ? arrayBuffer
            : new Uint8Array(arrayBuffer);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const eocdOffset = findEndOfCentralDirectory(view);
        const totalEntries = view.getUint16(eocdOffset + 10, true);
        const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true);
        const entries = new Map();
        let offset = centralDirectoryOffset;

        for (let index = 0; index < totalEntries; index += 1) {
            if (view.getUint32(offset, true) !== 0x02014b50) {
                throw new Error('EPUB ZIP 中央目录损坏');
            }

            const flags = view.getUint16(offset + 8, true);
            const compressionMethod = view.getUint16(offset + 10, true);
            const compressedSize = view.getUint32(offset + 20, true);
            const uncompressedSize = view.getUint32(offset + 24, true);
            const fileNameLength = view.getUint16(offset + 28, true);
            const extraLength = view.getUint16(offset + 30, true);
            const commentLength = view.getUint16(offset + 32, true);
            const localHeaderOffset = view.getUint32(offset + 42, true);
            const nameBytes = bytes.subarray(offset + 46, offset + 46 + fileNameLength);
            const name = normalizeZipPath(decodeZipString(nameBytes, flags));

            if (name && !name.endsWith('/')) {
                entries.set(name.toLowerCase(), {
                    name,
                    flags,
                    compressionMethod,
                    compressedSize,
                    uncompressedSize,
                    localHeaderOffset
                });
            }

            offset += 46 + fileNameLength + extraLength + commentLength;
        }

        return {
            async getBytes(path) {
                const entry = entries.get(normalizeZipPath(path).toLowerCase());
                if (!entry) return null;
                return extractZipEntry(bytes, view, entry);
            },
            async getText(path) {
                const entryBytes = await this.getBytes(path);
                if (!entryBytes) return '';
                return new TextDecoder('utf-8').decode(entryBytes);
            }
        };
    }

    function findEndOfCentralDirectory(view) {
        const minOffset = Math.max(0, view.byteLength - 0xffff - 22);
        for (let offset = view.byteLength - 22; offset >= minOffset; offset -= 1) {
            if (view.getUint32(offset, true) === 0x06054b50) return offset;
        }
        throw new Error('EPUB ZIP 文件不完整');
    }

    async function extractZipEntry(bytes, view, entry) {
        const offset = entry.localHeaderOffset;
        if (view.getUint32(offset, true) !== 0x04034b50) {
            throw new Error(`EPUB ZIP 本地文件头损坏：${entry.name}`);
        }

        const fileNameLength = view.getUint16(offset + 26, true);
        const extraLength = view.getUint16(offset + 28, true);
        const dataOffset = offset + 30 + fileNameLength + extraLength;
        const compressedData = bytes.subarray(dataOffset, dataOffset + entry.compressedSize);

        if (entry.compressionMethod === ZIP_STORED) {
            return compressedData;
        }

        if (entry.compressionMethod === ZIP_DEFLATED) {
            const inflated = await inflateRaw(compressedData);
            if (entry.uncompressedSize && inflated.length !== entry.uncompressedSize) {
                return inflated.subarray(0, entry.uncompressedSize);
            }
            return inflated;
        }

        throw new Error(`EPUB 使用了暂不支持的 ZIP 压缩方式：${entry.compressionMethod}`);
    }

    async function inflateRaw(data) {
        if (typeof module === 'object' && module.exports && typeof require === 'function') {
            const zlib = require('node:zlib');
            return new Uint8Array(zlib.inflateRawSync(Buffer.from(data)));
        }

        if (typeof DecompressionStream === 'function') {
            const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
            return new Uint8Array(await new Response(stream).arrayBuffer());
        }

        throw new Error('当前浏览器不支持解压 EPUB 中的压缩章节');
    }

    function getContainerPackagePath(containerXml) {
        const rootfiles = getTagAttributes(containerXml, 'rootfile');
        const rootfile = rootfiles.find(item => /opf|package/i.test(item['media-type'] || '')) || rootfiles[0];
        return normalizeZipPath(rootfile?.['full-path'] || '');
    }

    function parseManifest(packageXml, packageDir) {
        const items = getTagAttributes(packageXml, 'item').map(attrs => {
            const href = attrs.href || '';
            const path = resolveZipPath(packageDir, href);
            return {
                id: attrs.id || '',
                href,
                path,
                mediaType: attrs['media-type'] || '',
                properties: attrs.properties || '',
                title: attrs.title || ''
            };
        });

        return {
            items,
            byId: new Map(items.map(item => [item.id, item]))
        };
    }

    function parseSpine(packageXml) {
        return getTagAttributes(packageXml, 'itemref').map(attrs => ({
            idref: attrs.idref || '',
            linear: (attrs.linear || '').toLowerCase()
        }));
    }

    async function parseChapterLabels(zip, manifest) {
        const labels = new Map();

        for (const item of manifest.items) {
            if (item.mediaType === 'application/x-dtbncx+xml' || /\.ncx$/i.test(item.href)) {
                const ncx = await zip.getText(item.path);
                parseNcxLabels(ncx, item.path).forEach((label, path) => labels.set(path, label));
            }
        }

        for (const item of manifest.items) {
            if (!hasProperty(item, 'nav')) continue;
            const navHtml = await zip.getText(item.path);
            parseNavLabels(navHtml, item.path).forEach((label, path) => labels.set(path, label));
        }

        return labels;
    }

    function parseNcxLabels(ncx, ncxPath) {
        const labels = new Map();
        const navPointPattern = /<[^:>\s]*:?navPoint\b[^>]*>([\s\S]*?)<\/[^:>\s]*:?navPoint>/gi;
        let match;
        while ((match = navPointPattern.exec(ncx))) {
            const block = match[1];
            const textMatch = block.match(/<[^:>\s]*:?text\b[^>]*>([\s\S]*?)<\/[^:>\s]*:?text>/i);
            const contentAttrs = getFirstTagAttributes(block, 'content');
            const src = contentAttrs?.src;
            const label = decodeHtmlEntities(stripTags(textMatch?.[1] || '')).trim();
            if (src && label) {
                labels.set(resolveZipPath(getDirectory(ncxPath), src), label);
            }
        }
        return labels;
    }

    function parseNavLabels(navHtml, navPath) {
        const labels = new Map();
        const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
        let match;
        while ((match = anchorPattern.exec(navHtml))) {
            const attrs = parseAttributes(match[1]);
            const href = attrs.href || '';
            const label = decodeHtmlEntities(stripTags(match[2])).trim();
            if (href && label) {
                labels.set(resolveZipPath(getDirectory(navPath), href), label);
            }
        }
        return labels;
    }

    function prependChapterLabel(text, label) {
        const cleanLabel = String(label || '').trim();
        if (!cleanLabel) return text;

        const firstLine = text.split(/\n+/).find(Boolean) || '';
        if (canonicalText(firstLine) === canonicalText(cleanLabel)) return text;
        return `${cleanLabel}\n\n${text}`;
    }

    function isHtmlManifestItem(item) {
        return /application\/xhtml\+xml|text\/html/i.test(item.mediaType)
            || /\.x?html?$/i.test(item.href);
    }

    function isSkippableEpubItem(item) {
        if (hasProperty(item, 'nav')) return true;
        if (hasProperty(item, 'cover-image')) return true;

        const marker = `${item.id} ${item.href}`.toLowerCase();
        return /(^|[\s/_.-])(nav|toc|contents?|cover|titlepage|copyright|rights|license|colophon)([\s/_.-]|$)/i.test(marker);
    }

    function hasProperty(item, propertyName) {
        return String(item.properties || '')
            .split(/\s+/)
            .some(value => value.toLowerCase() === propertyName.toLowerCase());
    }

    function htmlToReadableText(html) {
        let body = String(html || '')
            .replace(/<\?xml[\s\S]*?\?>/gi, '')
            .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/<head\b[\s\S]*?<\/head>/gi, '')
            .replace(/<script\b[\s\S]*?<\/script>/gi, '')
            .replace(/<style\b[\s\S]*?<\/style>/gi, '')
            .replace(/<svg\b[\s\S]*?<\/svg>/gi, '')
            .replace(/<nav\b[\s\S]*?<\/nav>/gi, '');

        const bodyMatch = body.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
        if (bodyMatch) body = bodyMatch[1];

        body = body
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/h[1-6]>/gi, '\n\n')
            .replace(/<h[1-6]\b[^>]*>/gi, '\n\n')
            .replace(/<\/(p|div|section|article|blockquote|li)>/gi, '\n\n')
            .replace(/<(p|div|section|article|blockquote|li|ul|ol)\b[^>]*>/gi, '\n')
            .replace(/<\/(tr|table)>/gi, '\n\n')
            .replace(/<\/(td|th)>/gi, ' ')
            .replace(/<hr\b[^>]*>/gi, '\n\n')
            .replace(/<[^>]+>/g, ' ');

        return decodeHtmlEntities(body)
            .replace(/\u00a0/g, ' ')
            .split('\n')
            .map(line => line.replace(/[ \t]+/g, ' ').trim())
            .join('\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    function getTagAttributes(xml, tagName) {
        const pattern = new RegExp(`<[^:>\\s]*:?${tagName}\\b([^>]*)>`, 'gi');
        const attrs = [];
        let match;
        while ((match = pattern.exec(xml))) {
            attrs.push(parseAttributes(match[1]));
        }
        return attrs;
    }

    function getFirstTagAttributes(xml, tagName) {
        return getTagAttributes(xml, tagName)[0] || null;
    }

    function parseAttributes(attributeText) {
        const attrs = {};
        const pattern = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
        let match;
        while ((match = pattern.exec(attributeText || ''))) {
            attrs[match[1]] = decodeHtmlEntities(match[2] ?? match[3] ?? '');
        }
        return attrs;
    }

    function stripTags(text) {
        return String(text || '').replace(/<[^>]+>/g, ' ');
    }

    function decodeHtmlEntities(text) {
        const named = {
            amp: '&',
            apos: "'",
            copy: '(c)',
            gt: '>',
            lt: '<',
            nbsp: ' ',
            ndash: '-',
            mdash: '-',
            quot: '"',
            rsquo: "'",
            lsquo: "'",
            rdquo: '"',
            ldquo: '"'
        };

        return String(text || '').replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (entity, value) => {
            const lower = value.toLowerCase();
            if (lower[0] === '#') {
                const codePoint = lower[1] === 'x'
                    ? parseInt(lower.slice(2), 16)
                    : parseInt(lower.slice(1), 10);
                return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
            }
            return Object.prototype.hasOwnProperty.call(named, lower) ? named[lower] : entity;
        });
    }

    function resolveZipPath(baseDir, href) {
        const withoutFragment = String(href || '').split('#')[0];
        const decodedHref = safeDecodeUri(withoutFragment);
        if (!decodedHref) return normalizeZipPath(baseDir);
        if (/^[a-z]+:/i.test(decodedHref)) return normalizeZipPath(decodedHref);
        return normalizeZipPath(`${baseDir ? `${baseDir}/` : ''}${decodedHref}`);
    }

    function getDirectory(path) {
        const normalized = normalizeZipPath(path);
        const lastSlash = normalized.lastIndexOf('/');
        return lastSlash === -1 ? '' : normalized.slice(0, lastSlash);
    }

    function normalizeZipPath(path) {
        const parts = String(path || '')
            .replace(/\\/g, '/')
            .replace(/^\/+/, '')
            .split('/');
        const normalized = [];

        parts.forEach(part => {
            if (!part || part === '.') return;
            if (part === '..') normalized.pop();
            else normalized.push(part);
        });

        return normalized.join('/');
    }

    function safeDecodeUri(value) {
        try {
            return decodeURIComponent(value);
        } catch (error) {
            return value;
        }
    }

    function decodeZipString(bytes, flags) {
        if (flags & UTF8_FLAG) return new TextDecoder('utf-8').decode(bytes);
        return new TextDecoder('utf-8').decode(bytes);
    }

    function canonicalText(text) {
        return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    }

    return {
        parseEpubToText,
        htmlToReadableText
    };
});
