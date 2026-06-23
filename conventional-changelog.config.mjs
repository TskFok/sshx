import createPreset from "conventional-changelog-conventionalcommits";

export default createPreset({
  types: [
    { type: "chore", scope: "release", hidden: true },
    { type: "feat", section: "新功能" },
    { type: "fix", section: "修复" },
    { type: "refactor", section: "重构" },
    { type: "chore", section: "日常维护" },
    { type: "ci", section: "CI / 部署" },
    { type: "build", section: "依赖 / 构建" },
    { type: "docs", section: "文档" },
    { type: "test", section: "测试" },
  ],
});
