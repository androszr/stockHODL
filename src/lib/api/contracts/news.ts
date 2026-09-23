import { z } from 'zod';

import { epochMsSchema } from './common';

/**
 * News — the phone's read of the feed and of one article.
 *
 * What is deliberately ABSENT is the interesting part. The hero image URL and
 * the publisher logo URL never cross this wire, exactly as they never cross
 * the web's: the payload carries `hasImage` / `hasPublisherLogo` booleans and
 * the client asks `/api/mobile/v1/news/image/<id>` for the bytes. The vendor's
 * asset host stays unnamed, the client never makes a request the server did
 * not mediate (non-negotiable #4), and a publisher that would 404 renders
 * name-only instead of a permanently-broken box.
 *
 * `degraded` is a first-class field rather than an error: the freshest refresh
 * attempt failed but stored rows are still worth showing, and "these may be
 * stale" is a truthful caption where an empty screen would be a lie.
 */

export const newsItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  publisherName: z.string().nullable(),
  /** Epoch ms — formatted device-local, never pre-formatted server-side. */
  publishedAtMs: epochMsSchema,
  hasImage: z.boolean(),
  hasPublisherLogo: z.boolean(),
  /** The user's own symbols this article names; every card shows ≥ 1. */
  matchedTickers: z.array(z.string()),
});

export type NewsItemContract = z.output<typeof newsItemSchema>;

export const newsFeedResponseSchema = z.object({
  articles: z.array(newsItemSchema),
  /**
   * Symbols the per-request cap pushed out of the query, named honestly
   * rather than silently dropped — otherwise "no news for X" and "we never
   * asked about X" look identical on screen.
   */
  omitted: z.array(z.string()),
  degraded: z.boolean(),
});

export type NewsFeedResponse = z.output<typeof newsFeedResponseSchema>;

export const newsArticleResponseSchema = z.object({
  id: z.string(),
  title: z.string(),
  author: z.string().nullable(),
  publisherName: z.string().nullable(),
  publisherHomepage: z.string().nullable(),
  publishedAtMs: epochMsSchema,
  /** The publisher's own page — opened in Safari, never rendered in-app. */
  articleUrl: z.string(),
  hasImage: z.boolean(),
  description: z.string().nullable(),
  /** Every ticker the vendor tagged, alphabetical. */
  tickers: z.array(z.string()),
  /**
   * The subset of `tickers` the phone may turn into a tap through to an
   * instrument — watched or held ONLY, exactly as on the web, because that
   * screen 404s for anything else by design and a dead link is worse than
   * plain text. Option underlyings deliberately do not qualify.
   */
  linkableTickers: z.array(z.string()),
  keywords: z.array(z.string()),
  /** Vendor sentiment where the row has it; most rows have none. */
  insights: z.array(
    z.object({
      ticker: z.string(),
      /** The vendor's word, verbatim — never mapped to an enum here. */
      sentiment: z.string().nullable(),
    }),
  ),
});

export type NewsArticleResponse = z.output<typeof newsArticleResponseSchema>;
