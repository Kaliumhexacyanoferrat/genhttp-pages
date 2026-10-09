// The bits of the GitHub Actions toolkit the action needs, without the toolkit.

import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export function input(name, fallback = '') {
  const value = process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`];
  return value === undefined || value === '' ? fallback : value.trim();
}

export function flag(name, fallback = false) {
  const value = input(name, String(fallback)).toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

function escapeData(text) {
  return String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export function mask(secret) {
  if (secret) {
    console.log(`::add-mask::${escapeData(secret)}`);
  }
}

export const log = (text) => console.log(text);
export const notice = (text) => console.log(`::notice::${escapeData(text)}`);
export const warning = (text) => console.log(`::warning::${escapeData(text)}`);
export const error = (text) => console.log(`::error::${escapeData(text)}`);

export function group(title) {
  console.log(`::group::${escapeData(title)}`);
}

export function endGroup() {
  console.log('::endgroup::');
}

function appendTo(variable, text) {
  const file = process.env[variable];
  if (file) {
    appendFileSync(file, text, 'utf8');
  }
}

export function output(name, value) {
  const delimiter = `ghadelimiter_${randomUUID()}`;
  appendTo('GITHUB_OUTPUT', `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

export function summary(markdown) {
  appendTo('GITHUB_STEP_SUMMARY', markdown.endsWith('\n') ? markdown : markdown + '\n');
}
