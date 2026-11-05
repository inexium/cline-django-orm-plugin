import { describe, expect, it } from "vitest";
import { buildRelationIndex, parseModels } from "../src/analysis/models-parser.js";
import { scanPythonSource } from "../src/analysis/python-scanner.js";

const relations = buildRelationIndex(
  parseModels(
    `
class Author(models.Model):
    name = models.CharField(max_length=10)

class Post(models.Model):
    author = models.ForeignKey(Author, on_delete=models.CASCADE, related_name="posts")
    tags = models.ManyToManyField("Tag")
`,
    "models.py",
  ),
);

const scan = (src: string) => scanPythonSource(src, "views.py", { relations });
const rules = (src: string) => scan(src).map((f) => `${f.line}:${f.rule}`);

describe("scanPythonSource", () => {
  it("flags FK access and related managers in a loop", () => {
    const src = [
      "def view(request):",
      "    posts = Post.objects.all()",
      "    for post in posts:",
      "        print(post.author.name)",
      "        print(post.tags.all())",
      "        print(post.tags.count())",
    ].join("\n");
    const findings = scan(src);
    expect(findings.map((f) => `${f.line}:${f.rule}:${f.confidence}`)).toEqual([
      "4:fk-access-in-loop:high",
      "5:related-manager-in-loop:high",
      "6:related-manager-in-loop:high",
    ]);
    expect(findings[2]?.suggestion).toContain('Count("tags")');
  });

  it("respects select_related / prefetch_related on the iterable or its assignment", () => {
    const src = [
      "def view(request):",
      '    posts = Post.objects.select_related("author")',
      '    posts = posts.prefetch_related("tags")',
      "    for post in posts:",
      "        print(post.author.name, post.tags.all(), post.tags.count())",
      '    for p in Post.objects.select_related("author"):',
      "        print(p.author.name)",
    ].join("\n");
    expect(scan(src)).toEqual([]);
  });

  it("flags filtering a prefetched relation", () => {
    const src = [
      'for post in Post.objects.prefetch_related("tags"):',
      '    post.tags.filter(name="x")',
    ].join("\n");
    expect(rules(src)).toEqual(["2:filtered-prefetch-in-loop"]);
  });

  it("flags deeper traversals not covered by select_related", () => {
    const rel = buildRelationIndex(
      parseModels(
        "class Post(models.Model):\n    author = models.ForeignKey('Author', on_delete=models.CASCADE)\nclass Author(models.Model):\n    user = models.OneToOneField('auth.User', on_delete=models.CASCADE)\n",
        "models.py",
      ),
    );
    const src = 'for post in Post.objects.select_related("author"):\n    print(post.author.user.email)\n';
    const findings = scanPythonSource(src, "v.py", { relations: rel });
    expect(findings.map((f) => f.rule)).toEqual(["fk-access-in-loop"]);
    expect(findings[0]?.suggestion).toContain('"author__user"');
  });

  it("flags queries, create, save and delete inside loops", () => {
    const src = [
      "for pk in ids:",
      "    a = Author.objects.get(pk=pk)",
      "    Post.objects.create(author=a)",
      "for post in Post.objects.all():",
      "    post.save()",
      "    post.delete()",
    ].join("\n");
    expect(rules(src)).toEqual(["2:query-in-loop", "3:create-in-loop", "5:save-in-loop", "6:delete-in-loop"]);
  });

  it("flags comprehensions", () => {
    const src = "names = [p.author.name for p in Post.objects.filter(x=1)]";
    expect(rules(src)).toEqual(["1:fk-access-in-loop"]);
    expect(scan('names = [p.author.name for p in Post.objects.select_related("author")]')).toEqual([]);
  });

  it("flags per-object serializer and admin methods, even after a nested Meta class", () => {
    const src = [
      "class PostSerializer(serializers.ModelSerializer):",
      "    class Meta:",
      "        model = Post",
      "    def get_n(self, obj):",
      "        return obj.posts.count()",
      "class PostAdmin(admin.ModelAdmin):",
      "    def author_name(self, obj):",
      "        return obj.author.name",
      "    def other(self, request):",
      "        return request.user.name",
    ].join("\n");
    expect(rules(src)).toEqual(["5:related-manager-in-loop", "8:fk-access-in-loop"]);
  });

  it("flags whole-file anti-patterns", () => {
    const src = [
      "if Post.objects.filter(a=1):",
      "    pass",
      "if qs.count() > 0:",
      "    pass",
      "n = len(Post.objects.all())",
      "first = list(Post.objects.all())[0]",
    ].join("\n");
    expect(rules(src)).toEqual(["1:queryset-truthiness", "3:count-for-existence", "5:len-queryset", "6:list-then-index"]);
  });

  it("flags nested serializers and dotted sources", () => {
    const src = [
      "class PostSerializer(serializers.ModelSerializer):",
      "    tags = TagSerializer(many=True, read_only=True)",
      "    author = AuthorSerializer()",
      '    author_name = serializers.CharField(source="author.name")',
    ].join("\n");
    const findings = scan(src);
    expect(findings.map((f) => `${f.line}:${f.rule}`)).toEqual(["2:nested-serializer", "3:nested-serializer", "4:dotted-source"]);
    expect(findings[0]?.suggestion).toContain('prefetch_related("tags")');
    expect(findings[1]?.suggestion).toContain('select_related("author")');
  });

  it("ignores comments, docstrings, ids and non-queryset iterables", () => {
    const src = [
      '"""',
      "for post in posts:",
      "    post.author.name",
      '"""',
      "# for post in posts: post.author.name",
      "for i in range(10):",
      "    Post.objects.get(pk=i).title",
      "for post in posts:",
      "    print(post.author_id, post.pk, post.title)",
      "for key, value in data.items():",
      "    value.author.name",
    ].join("\n");
    expect(rules(src)).toEqual([]);
  });

  it("reports unknown attribute chains with low confidence when models are indexed", () => {
    const findings = scan("for post in posts:\n    print(post.created_at.year)\n");
    expect(findings.map((f) => f.confidence)).toEqual(["low"]);
  });
});
