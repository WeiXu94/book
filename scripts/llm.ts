import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();
const MODEL = 'claude-sonnet-4-6';

/**
 * Generate an engaging Chinese summary (~100-150 chars) for a chapter/part.
 */
export async function summarizeChapter(
  plainText: string,
  bookTitle: string,
  chapterTitle: string,
): Promise<string> {
  // Trim to a reasonable input size
  const excerpt = plainText.slice(0, 4000).trim();

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 400,
    messages: [
      {
        role: 'user',
        content: `你是一位精通文学的书评人，擅长用生动有趣的语言吸引读者阅读。

书名：《${bookTitle}》
章节：${chapterTitle}

以下是本章节的内容（节选）：

${excerpt}

请用中文写一段约100-150字的章节简介，要能激发读者的阅读兴趣，生动有趣，可以适当制造悬念，但不要剧透太多关键情节。直接输出简介内容，不需要任何前缀、标题或引号。`,
      },
    ],
  });

  const block = message.content[0];
  if (block.type !== 'text') throw new Error('Unexpected LLM response type');
  return block.text.trim();
}

/**
 * Ask the LLM to choose the best narrative split point from a set of candidate paragraphs.
 * Returns the 0-indexed paragraph number (within the full paragraph list) to end Part 1 at.
 *
 * `paragraphs`   — full plain-text paragraph array
 * `targetIndex`  — mechanical target (0-indexed) around which to consider candidates
 */
export async function findNarrativeSplitPoint(
  paragraphs: string[],
  targetIndex: number,
): Promise<number> {
  const windowStart = Math.max(0, targetIndex - 6);
  const windowEnd = Math.min(paragraphs.length - 1, targetIndex + 6);

  const numbered = paragraphs
    .slice(windowStart, windowEnd + 1)
    .map((p, i) => `[${windowStart + i + 1}] ${p.slice(0, 300).trim()}`)
    .join('\n\n');

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 50,
    messages: [
      {
        role: 'user',
        content: `我需要把一篇小说章节分成两部分，第一部分大约在段落 ${targetIndex + 1} 附近结束。请从以下候选段落中，选出最适合作为第一部分结尾的段落编号——理想情况下应选在一个情节节点、场景切换或情绪高潮之后，让读者对第二部分产生期待。

候选段落：

${numbered}

只需回复一个整数（段落编号），不需要任何解释。`,
      },
    ],
  });

  const block = message.content[0];
  if (block.type !== 'text') throw new Error('Unexpected LLM response type');

  const num = parseInt(block.text.trim(), 10);
  if (isNaN(num) || num < 1 || num > paragraphs.length) return targetIndex;
  return num - 1; // convert 1-indexed → 0-indexed
}
