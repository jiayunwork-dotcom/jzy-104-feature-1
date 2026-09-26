'use strict';

// 物理常量与时间基准。
// 法拉第常数取 CODATA 公认推荐值（摩尔基本电荷 e·N_A），
// 而不是 96500 C/mol 之类随手取的近似整数。
const FARADAY_CONSTANT = 96485.33212; // C/mol（库仑每摩尔）

const SECONDS_PER_DAY = 86400; // 秒 / 天
const DAYS_PER_YEAR = 365; // 工程惯例年：365 天
const SECONDS_PER_YEAR = SECONDS_PER_DAY * DAYS_PER_YEAR; // 31 536 000 秒
const MM_PER_M = 1000;
const GRAMS_PER_KG = 1000;

module.exports = {
  FARADAY_CONSTANT,
  SECONDS_PER_DAY,
  DAYS_PER_YEAR,
  SECONDS_PER_YEAR,
  MM_PER_M,
  GRAMS_PER_KG,
};
