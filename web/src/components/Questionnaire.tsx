import { useState } from "react";
import type { QuestionnaireView } from "../api.ts";

interface QuestionnaireProps {
  questionnaire: QuestionnaireView;
  busy: boolean;
  onSubmit: (answers: Record<string, string | string[]>) => Promise<void>;
}

export function Questionnaire({ questionnaire, busy, onSubmit }: QuestionnaireProps) {
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [error, setError] = useState<string | null>(null);

  const setAnswer = (id: string, value: string | string[]) => {
    setAnswers((current) => ({ ...current, [id]: value }));
  };

  const toggleMulti = (id: string, option: string) => {
    const current = Array.isArray(answers[id]) ? (answers[id] as string[]) : [];
    setAnswer(
      id,
      current.includes(option) ? current.filter((item) => item !== option) : [...current, option],
    );
  };

  const submit = async () => {
    for (const question of questionnaire.questions) {
      if (question.required === false) continue;
      const value = answers[question.id];
      if (value === undefined || value === "" || (Array.isArray(value) && !value.length)) {
        setError(`请回答：${question.prompt}`);
        return;
      }
    }
    setError(null);
    await onSubmit(answers);
  };

  return (
    <section className="panel questionnaire">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Questionnaire</p>
          <h3>需要你补充信息</h3>
        </div>
        <span className="badge warn">{questionnaire.questions.length} 题</span>
      </div>

      {questionnaire.questions.map((question) => (
        <div className="question" key={question.id}>
          <p className="question-title">
            {question.prompt}
            {question.required === false ? <span className="muted">（可选）</span> : null}
          </p>

          {question.kind === "single_choice" && (
            <div className="options">
              {(question.options ?? []).map((option) => (
                <label key={option}>
                  <input
                    type="radio"
                    name={question.id}
                    checked={answers[question.id] === option}
                    onChange={() => setAnswer(question.id, option)}
                  />
                  {option}
                </label>
              ))}
            </div>
          )}

          {question.kind === "multi_choice" && (
            <div className="options">
              {(question.options ?? []).map((option) => (
                <label key={option}>
                  <input
                    type="checkbox"
                    checked={
                      Array.isArray(answers[question.id]) &&
                      (answers[question.id] as string[]).includes(option)
                    }
                    onChange={() => toggleMulti(question.id, option)}
                  />
                  {option}
                </label>
              ))}
            </div>
          )}

          {question.kind === "date" && (
            <input
              type="date"
              value={typeof answers[question.id] === "string" ? (answers[question.id] as string) : ""}
              onChange={(event) => setAnswer(question.id, event.target.value)}
            />
          )}

          {question.kind === "text" && (
            <textarea
              rows={2}
              value={typeof answers[question.id] === "string" ? (answers[question.id] as string) : ""}
              onChange={(event) => setAnswer(question.id, event.target.value)}
              placeholder="你的回答"
            />
          )}
        </div>
      ))}

      {error && <p className="error">{error}</p>}
      <button type="button" className="primary" disabled={busy} onClick={() => void submit()}>
        提交回答
      </button>
    </section>
  );
}
