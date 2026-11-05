# migration files are skipped
for p in Post.objects.all():
    p.author.name
