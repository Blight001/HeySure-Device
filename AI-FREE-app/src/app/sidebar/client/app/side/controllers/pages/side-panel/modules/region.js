// 侧边栏 region / 路由信息解析

// 处理：collectRegionText的具体业务逻辑。
function collectRegionText(target, value) {
  if (value == null) return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectRegionText(target, item));
    return;
  }

  if (typeof value === 'string') {
    value.split(/[,\|;/]+/).forEach((part) => {
      const text = String(part || '').trim();
      if (text) target.push(text);
    });
    return;
  }

  if (typeof value !== 'object') {
    const text = String(value || '').trim();
    if (text) target.push(text);
  }
}

// 处理：pickFirstRegionText的具体业务逻辑。
function pickFirstRegionText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function pickRegionField(candidate, fields) {
  return pickFirstRegionText(...fields.map((field) => candidate[field]));
}

// 格式化/规范化：normalizeRegionCandidateInfo的具体业务逻辑。
function normalizeRegionCandidateInfo(candidate) {
  if (!candidate) return null;

  if (typeof candidate === 'string') {
    const regionName = candidate.trim();
    return regionName ? {
      regionName,
      regionCode: '',
      preferredGroupName: '',
      preferredNodeName: '',
      keywords: [regionName],
    } : null;
  }

  if (typeof candidate !== 'object') return null;

  const regionName = pickRegionField(candidate, [
    'regionInfo', 'region_info', 'regionName', 'region_name', 'region', 'area', 'areaName', 'area_name',
    'country', 'countryName', 'country_name', 'zone', 'zoneName', 'zone_name', 'location',
    'locationName', 'location_name', 'label', 'title', 'name', 'displayName', 'text', 'value',
  ]);
  const regionCode = pickRegionField(candidate, [
    'regionCode', 'region_code', 'code', 'isoCode', 'iso_code', 'countryCode', 'country_code',
  ]);
  const preferredGroupName = pickRegionField(candidate, [
    'preferredGroupName', 'preferred_group_name', 'proxyGroup', 'proxy_group', 'groupName',
    'group_name', 'selectorGroup', 'selector_group',
  ]);
  const preferredNodeName = pickRegionField(candidate, [
    'preferredNodeName', 'preferred_node_name', 'proxyNode', 'proxy_node', 'nodeName',
    'node_name', 'node', 'proxyName', 'proxy_name',
  ]);

  const keywordSource = [];
  const keywordFields = [
    'keywords', 'regionKeywords', 'region_keywords', 'searchKeywords', 'matchKeywords',
    'match_keywords', 'regionInfo', 'region_info', 'region', 'regionData', 'region_data',
  ];
  keywordFields.forEach((field) => collectRegionText(keywordSource, candidate[field]));
  [regionName, regionCode, preferredGroupName, preferredNodeName]
    .forEach((value) => collectRegionText(keywordSource, value));

  const keywords = Array.from(new Set(keywordSource.filter(Boolean)));
  const displayName = regionName || regionCode || preferredGroupName || preferredNodeName || keywords[0] || '';
  if (!displayName && !regionCode && !preferredGroupName && !preferredNodeName && keywords.length === 0) {
    return null;
  }

  return {
    regionName: displayName,
    regionCode,
    preferredGroupName,
    preferredNodeName,
    keywords,
  };
}

// 处理：collectRegionCandidates的具体业务逻辑。
function collectRegionCandidates(value, target = [], seen = new Set()) {
  if (value == null) return target;
  if (Array.isArray(value)) {
    value.forEach((item) => collectRegionCandidates(item, target, seen));
    return target;
  }

  const normalized = normalizeRegionCandidateInfo(value);
  if (normalized) {
    const signature = [
      normalized.regionName,
      normalized.regionCode,
      normalized.preferredGroupName,
      normalized.preferredNodeName,
      normalized.keywords.join('|'),
    ].join('::');
    if (!seen.has(signature)) {
      seen.add(signature);
      target.push(normalized);
    }
  }

  if (value && typeof value === 'object') {
    collectRegionCandidates(value.regionCandidates, target, seen);
    collectRegionCandidates(value.region_candidates, target, seen);
    collectRegionCandidates(value.regionList, target, seen);
    collectRegionCandidates(value.region_list, target, seen);
    collectRegionCandidates(value.regions, target, seen);
    collectRegionCandidates(value.regionOptions, target, seen);
    collectRegionCandidates(value.region_options, target, seen);
  }

  return target;
}

// 格式化/规范化：normalizeRegionRoutingInfo的具体业务逻辑。
function normalizeRegionRoutingInfo(regionInfo) {
  if (!regionInfo) return null;
  const regionCandidates = collectRegionCandidates(regionInfo);
  if (regionCandidates.length === 0) {
    return null;
  }

  const primary = regionCandidates[0];
  const keywordSet = new Set();
  const regionNames = [];
  const regionCodes = [];
  const groupNames = [];
  const nodeNames = [];

  for (const candidate of regionCandidates) {
    collectRegionText(regionNames, candidate.regionName);
    collectRegionText(regionCodes, candidate.regionCode);
    collectRegionText(groupNames, candidate.preferredGroupName);
    collectRegionText(nodeNames, candidate.preferredNodeName);
    candidate.keywords.forEach((keyword) => keywordSet.add(String(keyword || '').trim()));
  }

  const uniqueRegionNames = Array.from(new Set(regionNames.filter(Boolean)));
  const uniqueRegionCodes = Array.from(new Set(regionCodes.filter(Boolean)));
  const uniqueGroupNames = Array.from(new Set(groupNames.filter(Boolean)));
  const uniqueNodeNames = Array.from(new Set(nodeNames.filter(Boolean)));
  const mergedKeywords = Array.from(keywordSet);

  const regionName = pickFirstRegionText(
    primary?.regionName, uniqueRegionNames[0], uniqueRegionCodes[0], uniqueGroupNames[0],
    uniqueNodeNames[0], mergedKeywords[0],
  );
  const singleton = (values) => (values.length === 1 ? values[0] : '');
  const regionCode = pickFirstRegionText(primary?.regionCode, singleton(uniqueRegionCodes));
  const preferredGroupName = pickFirstRegionText(primary?.preferredGroupName, singleton(uniqueGroupNames));
  const preferredNodeName = pickFirstRegionText(primary?.preferredNodeName, singleton(uniqueNodeNames));

  return {
    regionName,
    regionCode,
    preferredGroupName,
    preferredNodeName,
    keywords: mergedKeywords,
    regionCandidates,
  };
}
