import { describe, expect, it } from "vitest";
import { buildRelationIndex, isModelsFile, parseModels } from "../src/analysis/models-parser.js";
import { scanTemplateSource } from "../src/analysis/template-scanner.js";

describe("parseModels", () => {
  const src = `
from django.db import models

class Base(models.Model):
    class Meta:
        abstract = True

class Book(Base, TimeStampedModel):
    author = models.ForeignKey(
        "library.Author",
        on_delete=models.CASCADE,
        related_name="books",
    )
    editor = ForeignKey(to=settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    isbn: str = models.OneToOneField("Isbn", on_delete=models.CASCADE)
    genres = models.ManyToManyField("Genre")

def helper():
    x = models.ForeignKey("Nope", on_delete=models.CASCADE)

class NotAModel(object):
    other = models.ForeignKey("Nope", on_delete=models.CASCADE)
`;
  const models = parseModels(src, "library/models.py");

  it("extracts models and relation fields", () => {
    expect(models.map((m) => m.name)).toEqual(["Base", "Book"]);
    const book = models[1];
    expect(book?.relations.map((r) => [r.name, r.kind, r.target, r.relatedName ?? null])).toEqual([
      ["author", "ForeignKey", "library.Author", "books"],
      ["editor", "ForeignKey", "settings.AUTH_USER_MODEL", "+"],
      ["isbn", "OneToOneField", "Isbn", null],
      ["genres", "ManyToManyField", "Genre", null],
    ]);
  });

  it("builds single / multi valued accessor sets", () => {
    const index = buildRelationIndex(models);
    expect([...index.singleValued].sort()).toEqual(["author", "book", "editor", "isbn"]);
    expect([...index.multiValued].sort()).toEqual(["book_set", "books", "genres"]);
  });

  it("recognizes models files", () => {
    expect(isModelsFile("app/models.py")).toBe(true);
    expect(isModelsFile("app/models/book.py")).toBe(true);
    expect(isModelsFile("app/views.py")).toBe(false);
  });
});

describe("scanTemplateSource", () => {
  const relations = buildRelationIndex(
    parseModels('class Post(models.Model):\n    author = models.ForeignKey("Author", on_delete=models.CASCADE)\n    tags = models.ManyToManyField("Tag")\n', "m.py"),
  );

  it("flags relation access in for loops, including nested loop iterables", () => {
    const src = [
      "{% for post in posts %}",
      "  {{ post.author.name }} {{ post.tags.count }}",
      "  {% for tag in post.tags.all %}{{ tag.name }}{% endfor %}",
      "{% endfor %}",
      "{{ post.author.name }}",
    ].join("\n");
    const findings = scanTemplateSource(src, "t.html", relations);
    expect(findings.map((f) => `${f.line}:${f.rule}:${f.confidence}`)).toEqual([
      "2:template-fk-access:high",
      "2:template-related-manager:high",
      "3:template-related-manager:high",
    ]);
    expect(findings[1]?.suggestion).toContain('Count("tags")');
  });

  it("ignores plain fields and ids", () => {
    expect(scanTemplateSource("{% for p in posts %}{{ p.title }} {{ p.author_id.x }}{% endfor %}", "t.html", relations)).toEqual([]);
  });
});
