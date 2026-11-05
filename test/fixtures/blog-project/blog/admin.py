from django.contrib import admin

from .models import Post


@admin.register(Post)
class PostAdmin(admin.ModelAdmin):
    list_display = ["title", "author_name"]

    def author_name(self, obj):
        return obj.author.name
