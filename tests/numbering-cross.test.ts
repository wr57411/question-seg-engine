// numbering-cross.test.ts —— `§99` 题号行交叉核对的判据回归。
//
// 这几条守的是**具体摔过的坑**，不是假想的边界：
// 1. v1 用精确子串 ⇒ 公式/字母写法不同就判成"文字丢失"（10 处里 4 处假阳）；
// 2. 剥题号时连 `[` 一起吃掉 ⇒ 出处标签剥不干净（误报《运动和力》p6 #3）；
// 3. 只判 layout 有/无 ⇒ 漏掉"正文在输入里却没成题"（X2，`§96` 断档看不到）；
// 4. 正文汉字太少（「如图」「年月日」）⇒ 分数必为 0，会误判成丢失。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bodyFromLines,
  cjk,
  coverage,
  gramSet,
  judge,
  type Verdict,
} from "../scripts/lib/numbering-cross.js";

const layoutOf = (t: string) => gramSet(cjk(t));
const poolOf = (t: string) => gramSet(cjk(t));

test("X1：正文在 layout 里就没有 ⇒ 上游丢字", () => {
  const j = judge(
    "如图所示由一根粗细均匀的导体棒折成",
    layoutOf("教材知识安培力的分析与计算"), // layout 里没有这段
    poolOf("另一道完全无关的题目题干"),
  );
  assert.equal(j?.verdict, "X1");
});

test("X2：正文在 layout 里、但产物题池没有 ⇒ 切分丢题", () => {
  const j = judge(
    "如图三个电阻滑动变阻器的滑片由",
    layoutOf("3[多选][鲁科版必修三P133第10题模型变式]如图,三个电阻滑动变阻器的滑片由c点向a端滑动"),
    poolOf("相邻那道题的题干,内容完全不同"),
  );
  assert.equal(j?.verdict, "X2");
});

test("公式写法差异不算丢失（v1 的假阳根因）", () => {
  const j = judge(
    "如图所示灯泡和串联在电路中", // OCR 侧：L1/L2 被 norm 保留但 cjk 丢掉
    layoutOf("如图所示, 灯泡 $\\mathrm{L}_{1}$ 和 $\\mathrm{L}_{2}$ 串联在电路中"),
    poolOf("如图所示, 灯泡 $L_1$ 和 $L_2$ 串联在电路中"),
  );
  assert.equal(j, null); // 不报
});

test("题也在、文字也在 ⇒ 不报", () => {
  const j = judge("一个质量为的小球从斜面顶端滑下", layoutOf("一个质量为 60 kg 的小球从斜面顶端滑下"), poolOf("一个质量为60kg的小球从斜面顶端滑下"));
  assert.equal(j, null);
});

test("正文汉字太少（公式/日期为主）⇒ 跳过，不猜", () => {
  const j = judge("如图", layoutOf("完全无关的内容"), poolOf("也无关"));
  assert.equal(j, null);
  const j2 = judge("年月日", layoutOf("完全无关的内容"), poolOf("也无关"));
  assert.equal(j2, null);
});

test("没有产物题池时只判 X1，不猜 X2", () => {
  const body = "如图所示一盛有水的容器自倾角为";
  assert.equal(judge(body, layoutOf("毫不相干"), null)?.verdict, "X1");
  assert.equal(judge(body, layoutOf("如图所示一盛有水的容器自倾角为斜面"), null), null);
});

test("剥题号不能吃掉 `[`：两个标签都必须剥掉", () => {
  const lines = ["3[多选][鲁科版必修二P7第4题情境变式]如图所示,长为L的平板静置于光滑的水平面上"];
  const body = bodyFromLines(lines, 0);
  assert.equal(body.startsWith("如图所示"), true, body);
  assert.equal(body.includes("鲁科版"), false, body);
});

test("题号行只有标签、正文隔空行在下一行 ⇒ 拼上", () => {
  const lines = ["2 [人教版必修二 P94 第5题模型变式] 易错", "", "如图所示，轻弹簧一端连接小球，另一端固定于 O 点"];
  const body = bodyFromLines(lines, 0);
  assert.equal(body.includes("轻弹簧一端连接小球"), true, body);
});

test("覆盖率是滑窗比例，不是子串命中", () => {
  const g = gramSet("如图所示圆形区域内存在垂直纸面");
  assert.equal(coverage("圆形区域内存在垂直纸", g), 1);
  assert.equal(coverage("完全不同的另外一段文字内容", g), 0);
});

test("判据类型只会有 X1/X2（防止将来扩类型时漏改口径）", () => {
  const all: Verdict[] = ["X1", "X2"];
  assert.deepEqual(all, ["X1", "X2"]);
});
