from django.shortcuts import render

from .models import Author, Comment, Post


def post_list(request):
    # N+1: author and tags are loaded once per post
    posts = Post.objects.filter(published=True)
    rows = []
    for post in posts:
        rows.append({
            "title": post.title,
            "author": post.author.name,
            "tags": [t.name for t in post.tags.all()],
            "comments": post.comment_set.count(),
        })
    return render(request, "blog/post_list.html", {"posts": posts, "rows": rows})


def post_list_optimized(request):
    posts = Post.objects.select_related("author").prefetch_related("tags")
    data = [{"author": p.author.name, "tags": [t.name for t in p.tags.all()]} for p in posts]
    return render(request, "blog/post_list.html", {"posts": posts, "data": data})


def publish_all(request):
    for post in Post.objects.filter(published=False):
        post.published = True
        post.save()
    for author_id in request.POST.getlist("authors"):
        author = Author.objects.get(pk=author_id)
        Comment.objects.create(post_id=1, author=author, body="hi")
    if Post.objects.filter(published=False):
        pass
    if Post.objects.count() > 0:
        pass
    total = len(Post.objects.all())
    return total


def prefetch_bypassed(request):
    posts = Post.objects.prefetch_related("tags")
    for post in posts:
        print(post.tags.filter(name__startswith="a"))
