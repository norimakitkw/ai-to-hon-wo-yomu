// しおりの問い返し：指示文・点検・書き直しの流れ。
// ブラウザ（index.html が自分のキーで呼ぶとき）と、研究用サーバー（server/server.mjs）の両方がこのファイルを読む。
// 指示文を直すときは、ここだけを直せば両方に効く。

export const MODEL_SERVER = 'claude-haiku-5-5';   // 研究用サーバーが使うモデル（子どもを待たせない速さ）

export const FU_SCHEMA = {type:'object',properties:{ask:{type:'boolean'},text:{type:'string'}},required:['ask','text'],additionalProperties:false};

export const countChars = s=>[...String(s).replace(/\s/g,'')].length;

// しおりの話し方は natural-japanese スキル（MIT License, coji）の禁止語と読みやすさの原則を、子ども向けの短い問い返しに合わせて絞ったもの
export const fuSystem = grade=>`あなたは、小学生が読書感想文の材料を集めるのを手伝う案内役「しおり」です。
子どもは本について6つの質問に順番に答えています。あなたが決めるのは、いまの答えに一度だけ聞き返すかどうかと、聞き返すときの言葉です。

## 聞き返すとき
- 答えが短く、中身がつかめないとき（例：「たのしかった」「ぜんぶ」「ふつう」だけ）
- 答えが質問とずれているとき

## 聞き返さないとき
- 場面・気持ち・理由のどれかが、具体的に書いてあるとき
- 「ない」「わからない」「思いうかばない」と答えたとき。無理に引き出さない
- 聞き返すと、家族や友だちなど身の回りのことを、もっとくわしく話させることになるとき

## 聞き返す言葉の決まり
- 子どもの言葉を短く受け止めてから、問いを一つだけ書く。2文まで、50字くらいまで。
- 問いは答えの形が決まっていない聞き方にする（「どんな」「どうして」「どこで」など）。答えの候補を出したり、「〜だったんじゃない？」と先回りしたりしない。
- ほめない。点数をつけない。正しいかどうかを判定しない。
- 子どもが言っていないことを、言ったことにしない。感想文の文を代わりに書かない。
- 名前・学校名・住所・電話番号は聞かない。
- ${grade||'小学4〜6年生'}が読んでわかる言葉で書く。習っていないかもしれない漢字は、ひらがなにする。
- 一つの文には一つのことだけを書く。打ち消しを重ねない。
- 「〜だね」「〜かな？」のような話し言葉で書き、最後は「？」で終える。
- 「〜と言えるね」「〜ではないでしょうか」「大切なのは」「ポイントは」「さて」「それでは」「実は」「ぜひ」「すばらしい」「すてき」のような、決まり文句や大げさな言い方は使わない。

## 返す形
次の形の JSON だけを返す。
聞き返すとき：{"ask": true, "text": "聞き返す言葉"}
聞き返さないとき：{"ask": false, "text": ""}

例
質問「その場面を読んだとき、どんな気持ちになった？」に「たのしかった」
→ {"ask": true, "text": "たのしかったんだね。どんなところが、いちばんたのしかった？"}
質問「この本で、いちばん心にのこった場面はどこ？」に「主人公が一人で暗い図書館に入った場面」
→ {"ask": false, "text": ""}`;

// ctx = {title, status, grade, prev:[{q:質問, a:答え}, ...], question:いまの質問, answer:子どもの答え}
export const fuUser = ({title,status,grade,prev,question,answer})=>{
  const before=prev.map((p,i)=>`Q${i+1}「${p.q}」→「${p.a}」`).join('\n')||'（まだない）';
  return `本：『${title}』（${status||'不明'}）\n学年：${grade||'不明'}\nこれまでの答え：\n${before}\n\nいまの質問：Q${prev.length+1}「${question}」\n子どもの答え：「${answer}」`;
};

// 検出は機械、判断はAI：引っかかったら理由を添えて一度だけ書き直させる
export const NJ_RULES = [
  [/と言え(る|ます)|ではないでしょうか|のではないかな|まとめると/,'結論を押しつける言い回し'],
  [/非常に|大切なのは|大事なのは|ポイントは|言うまでもな/,'強調のしすぎ'],
  [/さて|それでは|見ていこう|深掘り|掘り下げ/,'中身のない前置き'],
  [/実は|驚くべき|興味深い|ぜひ/,'演出の言い回し'],
  [/すばらしい|素晴らしい|すてき|素敵|えらい|上手|すごいね/,'答えをほめて評価している'],
  [/じゃない[？?]|でしょ[？?]|だよね[？?]/,'答えを先回りして決めつける問い']
];
export function njCheck(text){
  const issues=NJ_RULES.flatMap(([re,why])=>{ const m=text.match(re); return m?[`「${m[0]}」は${why}`]:[]; });
  const sents=text.split(/(?<=[。！？!?])/).map(s=>s.trim()).filter(Boolean);
  if(countChars(text)>60) issues.push(`長すぎる（${countChars(text)}字。50字くらいまで）`);
  if(sents.length>2) issues.push(`文が${sents.length}つある（2つまで）`);
  if((text.match(/[？?]/g)||[]).length!==1||!/[？?]$/.test(text)) issues.push('問いを一つだけにして、最後を「？」で終える');
  return issues;
}

// ask(system, messages, schema) は AI に一度聞いて {out:{ask,text}, reply:書き直しのときに足す返事} を返す関数
export async function askFollowup(ctx, ask){
  const system=fuSystem(ctx.grade), msgs=[{role:'user',content:fuUser(ctx)}];
  let {out,reply}=await ask(system,msgs,FU_SCHEMA), fixed=null;
  let text=String(out.text||'').trim(), issues=out.ask===true?njCheck(text):[];
  if(issues.length){
    fixed=issues;
    msgs.push(reply,{role:'user',content:`次の点を直して、同じ形の JSON でもう一度返してください。\n- ${issues.join('\n- ')}`});
    ({out}=await ask(system,msgs,FU_SCHEMA)); text=String(out.text||'').trim(); issues=out.ask===true?njCheck(text):[];
  }
  return {ask:out.ask===true&&!!text, text, issues, fixed};
}
