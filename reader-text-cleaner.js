(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.cleanImportedText = api.cleanImportedText;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const DEFAULT_OPTIONS = {
        repeatedLineMaxLength: 80,
        repeatedLineMaxWords: 12,
        repeatedLineMinCount: 3,
        repeatedLineBoundaryMinCount: 2
    };

    const SMALL_TITLE_WORDS = new Set([
        'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in',
        'into', 'nor', 'of', 'on', 'or', 'over', 'the', 'to', 'with'
    ]);

    const NUMBER_WORDS = [
        'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
        'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen',
        'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
        'twenty'
    ].join('|');

    function cleanImportedText(rawText, options = {}) {
        const settings = { ...DEFAULT_OPTIONS, ...options };
        const normalized = normalizeRawText(rawText);
        if (!normalized.trim()) return '';

        const lines = normalized.split('\n').map(line => line.replace(/[ \t]+/g, ' '));
        const repeatedNoiseLines = findRepeatedNoiseLines(lines, settings);
        const filteredLines = [];

        lines.forEach(line => {
            if (isPageBreakLine(line)) {
                pushBlankLine(filteredLines);
                return;
            }

            const trimmed = line.trim();
            if (!trimmed) {
                pushBlankLine(filteredLines);
                return;
            }

            if (isPageNumberLine(trimmed)) return;

            const canonical = canonicalizeRepeatLine(trimmed);
            if (canonical && repeatedNoiseLines.has(canonical)) return;

            filteredLines.push(trimmed.replace(/[ \t]+/g, ' '));
        });

        return rebuildParagraphs(filteredLines)
            .join('\n\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    function normalizeRawText(rawText) {
        return String(rawText || '')
            .replace(/^\uFEFF/, '')
            .replace(/\u00ad/g, '')
            .replace(/\u00a0/g, ' ')
            .replace(/\r\n?/g, '\n')
            .replace(/\f/g, '\n\f\n')
            .replace(/[ \t]+\n/g, '\n');
    }

    function findRepeatedNoiseLines(lines, options) {
        const { pages, hasExplicitPageBreaks } = splitLinesIntoPages(lines);
        const boundaryIndexes = new Set();
        const linePageIndexes = new Map();

        pages.forEach((page, pageIndex) => {
            const nonBlankIndexes = page.filter(index => {
                const line = lines[index];
                return !isPageBreakLine(line) && line.trim();
            });

            nonBlankIndexes.forEach(index => linePageIndexes.set(index, pageIndex));

            if (!hasExplicitPageBreaks) return;

            [...nonBlankIndexes.slice(0, 2), ...nonBlankIndexes.slice(-2)]
                .forEach(index => boundaryIndexes.add(index));
        });

        const stats = new Map();
        lines.forEach((line, index) => {
            if (isPageBreakLine(line)) return;

            const trimmed = line.trim();
            if (!trimmed || isPageNumberLine(trimmed)) return;
            if (!isRepeatedLineCandidate(trimmed, options)) return;

            const canonical = canonicalizeRepeatLine(trimmed);
            if (!canonical) return;

            if (!stats.has(canonical)) {
                stats.set(canonical, {
                    count: 0,
                    boundaryCount: 0,
                    boundaryPages: new Set(),
                    examples: []
                });
            }

            const entry = stats.get(canonical);
            entry.count += 1;
            if (entry.examples.length < 3) entry.examples.push(trimmed);

            if (boundaryIndexes.has(index)) {
                entry.boundaryCount += 1;
                if (linePageIndexes.has(index)) {
                    entry.boundaryPages.add(linePageIndexes.get(index));
                }
            }
        });

        const repeatedNoiseLines = new Set();
        const knownTitle = canonicalizeRepeatLine(options.title || options.bookTitle || '');
        const knownAuthor = canonicalizeRepeatLine(options.author || '');

        stats.forEach((entry, canonical) => {
            const sample = entry.examples[0] || '';
            const matchesKnownMetadata = canonical && (canonical === knownTitle || canonical === knownAuthor);
            const repeatsAtPageEdge = hasExplicitPageBreaks
                && entry.boundaryCount >= options.repeatedLineBoundaryMinCount
                && entry.boundaryPages.size >= options.repeatedLineBoundaryMinCount
                && entry.boundaryCount / entry.count >= 0.5;
            const frequentShortLine = entry.count >= options.repeatedLineMinCount
                && isConservativeFrequentRepeat(sample);

            if ((matchesKnownMetadata && entry.count >= 2) || repeatsAtPageEdge || frequentShortLine) {
                repeatedNoiseLines.add(canonical);
            }
        });

        return repeatedNoiseLines;
    }

    function splitLinesIntoPages(lines) {
        const pages = [[]];
        let hasExplicitPageBreaks = false;

        lines.forEach((line, index) => {
            if (isPageBreakLine(line)) {
                hasExplicitPageBreaks = true;
                pages.push([]);
                return;
            }
            pages[pages.length - 1].push(index);
        });

        return { pages, hasExplicitPageBreaks };
    }

    function isPageBreakLine(line) {
        return String(line).includes('\f');
    }

    function pushBlankLine(lines) {
        if (lines.length && lines[lines.length - 1] !== '') {
            lines.push('');
        }
    }

    function isPageNumberLine(line) {
        const value = String(line || '').trim().replace(/[–—]/g, '-');
        if (!value) return false;

        if (/^\d{1,3}$/.test(value)) return true;
        if (/^-\s*\d{1,4}\s*-$/.test(value)) return true;
        if (/^page\s+\d{1,4}(?:\s*(?:of|\/)\s*\d{1,4})?$/i.test(value)) return true;
        if (/^p\.\s*\d{1,4}$/i.test(value)) return true;
        if (/^[ivxlcdm]{2,12}$/.test(value)) return true;
        if (/^-\s*[ivxlcdm]{2,12}\s*-$/.test(value)) return true;
        if (/^page\s+[ivxlcdm]{2,12}$/i.test(value)) return true;

        return false;
    }

    function isRepeatedLineCandidate(line, options) {
        const stripped = stripDecorativeMarks(line);
        if (!/[A-Za-z]/.test(stripped)) return false;
        if (stripped.length > options.repeatedLineMaxLength) return false;
        if (countWords(stripped) > options.repeatedLineMaxWords) return false;
        if (/^["'`]/.test(stripped)) return false;
        if (/^[-*]\s*["'`]/.test(stripped)) return false;
        return true;
    }

    function isConservativeFrequentRepeat(line) {
        const stripped = stripDecorativeMarks(line);
        if (/copyright|all rights reserved/i.test(stripped)) return true;
        if (isLikelyHeadingLine(stripped)) return true;
        if (isTitleOrNameLikeLine(stripped)) return true;
        return false;
    }

    function canonicalizeRepeatLine(line) {
        return stripDecorativeMarks(line)
            .toLowerCase()
            .replace(/&/g, ' and ')
            .replace(/['`]/g, '')
            .replace(/[^a-z0-9]+/g, ' ')
            .trim();
    }

    function stripDecorativeMarks(line) {
        return String(line || '')
            .trim()
            .replace(/^#{1,6}\s+/, '')
            .replace(/^[\s*_.-]+|[\s*_.-]+$/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function rebuildParagraphs(lines) {
        const paragraphs = [];
        let current = '';

        lines.forEach(line => {
            if (!line) {
                flushCurrent();
                return;
            }

            if (!current) {
                current = line;
                return;
            }

            if (shouldKeepSeparate(current, line)) {
                flushCurrent();
                current = line;
                return;
            }

            current = joinWrappedLines(current, line);
        });

        flushCurrent();
        return paragraphs;

        function flushCurrent() {
            const paragraph = normalizeParagraph(current);
            if (paragraph) paragraphs.push(paragraph);
            current = '';
        }
    }

    function shouldKeepSeparate(previous, next) {
        if (isLikelyHeadingLine(previous) || isLikelyHeadingLine(next)) return true;
        if (isListLikeLine(next)) return true;
        if (startsDialogueLine(next) && endsSentence(previous)) return true;
        return false;
    }

    function joinWrappedLines(previous, next) {
        if (/[A-Za-z]{2,}-\s*$/.test(previous) && /^[a-z]/.test(next)) {
            return previous.replace(/-\s*$/, '') + next;
        }
        return `${previous} ${next}`;
    }

    function normalizeParagraph(paragraph) {
        return String(paragraph || '')
            .replace(/[ \t]+/g, ' ')
            .replace(/\s+([,.;:!?])/g, '$1')
            .trim();
    }

    function isLikelyHeadingLine(line) {
        const stripped = stripDecorativeMarks(line);
        if (!stripped || stripped.length > 90 || !/[A-Za-z]/.test(stripped)) return false;
        if (/^#{1,6}\s+\S/.test(String(line || '').trim())) return true;

        const structuralHeading = new RegExp(
            `^(chapter|book|part|section|volume)\\s+([0-9]+|[ivxlcdm]+|${NUMBER_WORDS})(\\b.*)?$`,
            'i'
        );
        if (structuralHeading.test(stripped) && countWords(stripped) <= 8) return true;
        if (/^(prologue|epilogue|preface|contents|introduction)$/i.test(stripped)) return true;
        if (/^[A-Z][A-Z0-9 '\-:,]+$/.test(stripped) && countWords(stripped) <= 8 && !/[.!?]$/.test(stripped)) {
            return true;
        }

        return isTitleCaseLine(stripped);
    }

    function isTitleCaseLine(line) {
        if (/[.!?;,]$/.test(line)) return false;

        const words = line.match(/[A-Za-z0-9]+/g) || [];
        if (!words.length || words.length > 8) return false;

        const meaningfulWords = words.filter(word => {
            const lower = word.toLowerCase();
            return !SMALL_TITLE_WORDS.has(lower) && !/^\d+$/.test(word);
        });

        if (!meaningfulWords.length) return false;
        return meaningfulWords.every(word => /^[A-Z0-9]/.test(word));
    }

    function isTitleOrNameLikeLine(line) {
        const stripped = stripDecorativeMarks(line);
        if (!stripped || /[!?;,]$/.test(stripped)) return false;
        if (/\.$/.test(stripped) && !/\b[A-Z]\.$/.test(stripped)) return false;
        if (countWords(stripped) > 8) return false;
        if (!/[A-Z]/.test(stripped[0])) return false;
        return isTitleCaseLine(stripped) || /^[A-Z][A-Za-z0-9 .,'&-]+$/.test(stripped);
    }

    function isListLikeLine(line) {
        return /^(\d+\.|[A-Za-z]\.|\*|-)\s+\S/.test(String(line || '').trim());
    }

    function startsDialogueLine(line) {
        return /^["'`]/.test(String(line || '').trim());
    }

    function endsSentence(line) {
        return /[.!?]["')\]]?$/.test(String(line || '').trim());
    }

    function countWords(line) {
        return (String(line || '').match(/[A-Za-z0-9]+(?:[.'-][A-Za-z0-9]+)*/g) || []).length;
    }

    return {
        cleanImportedText
    };
});
