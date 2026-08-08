
/** USDC token contract on Base. */
export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

// No default inference model lives here on purpose. The model id is the one
// piece of configuration that goes stale on someone else's schedule (a model is
// retired and every run starts failing), so it is held in the INFERENCE_MODEL
// repo VARIABLE — editable in the repo settings UI — and never baked into the
// frozen scripts. A hardcoded fallback here would only mean a run silently
// using a stale id instead of failing with "set INFERENCE_MODEL".

/** Port the app listens on inside the VPS. */
export const APP_PORT = 3000

/** HTTP paths that must return 200 for the app to count as healthy. */
export const HEALTH_PATHS = ['/']

/** Smallest VPS RAM (MB) the planner will run on. */
export const RAM_FLOOR_MB = Number(process.env.RAM_FLOOR_MB || '2048')

/** Default runway (days) the provision/migrate planner sizes for. */
export const TARGET_DAYS = Number(process.env.TARGET_RUNWAY_DAYS || '21')

/**
 * The prepaid window, in hours. One day, everywhere: it is what a box is bought
 * with, and what renew.yml tops it back up by. Deliberately NOT tunable — 24 is
 * the provider's own floor ("Minimum prepaid period is 24 hours"), so the only
 * settable values were larger ones, and every one of them bought more exposure
 * on a box that might be replaced hours later. Extends are sold in whole days
 * anyway, so this is the only value the arithmetic ever lands on.
 */
export const PREPAID_HOURS = 24

/**
 * Extend once fewer than this many hours remain. renew.yml runs every 6h, so the
 * window can already be one interval below this before anything notices — at 12h
 * it bottoms out near 6h, and a SINGLE missed cron run kills the box. 18h keeps
 * three intervals in hand, surviving two missed runs.
 *
 * It is free: extends buy a whole day each, so the long-run spend is one prepaid
 * day per elapsed day whatever this is set to (simulated: 30 extends per 30 days
 * at 12h, 18h and 20h alike). A higher threshold only shifts the window up, and
 * the extra prepaid hours are all still consumed. Do not "save money" by
 * lowering it — there is none to save.
 */
export const RENEW_BELOW_HOURS = 18

/**
 * Prepaid windows are sold in whole days but read back a hair short: a box
 * bought for 24h reports 23.9h, because the clock has been running since the
 * provider stamped expires_at. Every comparison against an hours threshold
 * allows this much drift, or the arithmetic buys days it does not need.
 */
export const SETTLE_SLACK_HOURS = 1
